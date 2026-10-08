/**
 * dsh-qqmail — mail service facade.
 *
 * The single place that turns "the configured account" into real IMAP/SMTP
 * work. The agent tools, the loopback routes, the CLI and the MCP server all
 * call this class, so a tool result, a panel payload and a CLI printout can
 * never disagree about what the mailbox said.
 *
 * Failure policy: methods throw `Error` with a user-actionable Chinese message;
 * callers translate that into their own `{ ok: false, message }` shape.
 */

import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  DEFAULT_IDLE_MS,
  ImapSession,
  appendMessage,
  buildSearchCriteria,
  deleteMessages,
  describeImapError,
  fetchRawSource,
  fetchSummaries,
  listMailboxes,
  moveMessages,
  pickSpecialFolder,
  searchUids,
  storeFlags,
  withMailbox,
} from './core/imap.ts'
import { decodePreviewPart, parseSource, toDetail } from './core/parse.ts'
import { composeMessage, sendComposed, verifySmtp, type SmtpEndpoint } from './core/smtp.ts'
import { formatSize, parseDate, safeFilename, toAddressList } from './core/mime.ts'
import type {
  Account,
  AttachmentMeta,
  MailboxInfo,
  MessageDetail,
  MessageSummary,
  OutgoingMessage,
  ProbeResult,
  SearchQuery,
  SearchResult,
  SendResult,
} from './core/types.ts'
import type { MailStore } from './store.ts'

/** Window of recent messages scanned by the local-filter fallback. */
export const LOCAL_SEARCH_WINDOW = 400

/** Bytes requested per message for a list preview. */
const PREVIEW_BYTES = 4096

/** Bytes requested per message during a local (in-process) search. */
const LOCAL_PREVIEW_BYTES = 2048

/** One megabyte, used for every size cap. */
const MB = 1024 * 1024

/** Options for {@link MailService.listMessages}. */
export interface ListOptions {
  mailbox: string
  limit: number
  /** 'desc' = newest first (the agent-facing default). */
  order: 'asc' | 'desc'
  unseen: boolean
  flagged: boolean
  /** undefined = follow the stored `previewInList` setting. */
  preview: boolean | undefined
}

/** Options for {@link MailService.searchMessages}. */
export interface SearchOptions {
  limit: number
  order: 'asc' | 'desc'
  preview: boolean
}

/** Options for {@link MailService.readMessages}. */
export interface ReadOptions {
  mailbox: string
  /** Include the raw HTML body. */
  html: boolean
  /** Set the `\Seen` flag on the messages that were read. */
  markSeen: boolean
}

/** Result of reading one or more messages. */
export interface ReadResult {
  items: MessageDetail[]
  /** Per-UID failures (reading 5 mails must not fail because 1 is broken). */
  errors: string[]
}

/** Everything a caller must supply to send a message. */
export interface SendInput {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  html: string
  attachments: { filename: string; path: string; contentType?: string }[]
  inReplyTo: string
  references: string[]
  /** undefined = follow the stored `saveSent` setting. */
  saveSent: boolean | undefined
}

/** Result of an attachment download. */
export interface DownloadResult {
  path: string
  filename: string
  size: number
  contentType: string
}

/** Whether a summary satisfies a query locally (used by the fallback path). */
export function matchesLocally(summary: MessageSummary, query: SearchQuery): boolean {
  const from = summary.from.map((entry) => entry.name + ' ' + entry.address).join(' ').toLowerCase()
  const to = summary.to.map((entry) => entry.name + ' ' + entry.address).join(' ').toLowerCase()
  const subject = summary.subject.toLowerCase()
  const preview = summary.preview.toLowerCase()
  if (query.from !== '' && !from.includes(query.from.toLowerCase())) return false
  if (query.to !== '' && !to.includes(query.to.toLowerCase())) return false
  if (query.subject !== '' && !subject.includes(query.subject.toLowerCase())) return false
  if (query.body !== '' && !preview.includes(query.body.toLowerCase())) return false
  if (query.text !== '' && !(subject + ' ' + from + ' ' + to + ' ' + preview).includes(query.text.toLowerCase())) {
    return false
  }
  const stamp = summary.date === '' ? undefined : new Date(summary.date)
  if (query.since !== '') {
    const since = parseDate(query.since)
    if (since !== undefined && stamp !== undefined && stamp.getTime() < since.getTime()) return false
  }
  if (query.before !== '') {
    const before = parseDate(query.before)
    if (before !== undefined && stamp !== undefined && stamp.getTime() >= before.getTime()) return false
  }
  if (query.unseen && summary.seen) return false
  if (query.flagged && !summary.flagged) return false
  if (query.larger > 0 && summary.size <= query.larger) return false
  if (query.smaller > 0 && summary.size >= query.smaller) return false
  return true
}

/** The mail facade: one instance per plugin host (or per CLI run). */
export class MailService {
  private disposed = false
  private readonly sessions = new Map<string, ImapSession>()
  private readonly generations = new Map<string, number>()
  private readonly snapshots = new WeakMap<Account, number>()
  /** Auto-detected Sent folder per account ('' is a valid, cached answer). */
  private readonly sentFolders = new Map<string, string>()

  /**
   * @param store - the config store.
   * @param idleMs - how long a pooled connection stays open between calls.
   */
  constructor(
    private readonly store: MailStore,
    private readonly idleMs: number = DEFAULT_IDLE_MS,
  ) {
    this.unsubscribe = store.onAccountsChanged((emails) => this.dropSessionsFor(emails))
  }

  private readonly unsubscribe: () => void

  /** Release the Store hook when the host unloads. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.unsubscribe()
    await this.closeAll()
  }

  /** Retire only affected accounts; drain queued commands before closing. */
  async dropSessionsFor(emails: string | readonly string[]): Promise<void> {
    const targets = new Set(typeof emails === 'string' ? [emails] : emails)
    for (const email of targets) this.generations.set(email, (this.generations.get(email) ?? 0) + 1)
    const pending: Promise<void>[] = []
    for (const [key, session] of this.sessions) {
      if (targets.has(key.split('|')[0]!)) {
        this.sessions.delete(key)
        pending.push(session.retire())
      }
    }
    for (const email of targets) {
      for (const key of [email, email + ':trash', email + ':drafts', email + ':junk']) this.sentFolders.delete(key)
    }
    await Promise.all(pending)
  }

  /** Resolve the account or throw a readable error. */
  private accountOrThrow(ref?: string): Account {
    if (this.disposed) throw new Error('邮箱服务已卸载。')
    const config = this.store.readSync()
    const view = this.store.view()
    const { account, error } = this.store.account(view, config, ref)
    if (error !== '') throw new Error(error)
    const generation = this.generations.get(account.email) ?? 0
    this.generations.set(account.email, generation)
    this.snapshots.set(account, generation)
    return account
  }

  private isCurrent(account: Account): boolean {
    return this.snapshots.get(account) === (this.generations.get(account.email) ?? 0)
  }

  /** Whether the stored config is complete enough to try connecting. */
  isConfigured(ref?: string): boolean {
    return this.store.isConfigured(this.store.readSync(), ref)
  }

  /** Get (or open) the pooled session for one account. */
  private session(account: Account): ImapSession {
    if (!this.isCurrent(account)) throw new Error('邮箱配置已变更，请重试请求。')
    // The authorization code is hashed so a leaked heap dump or a log line
    // cannot recover the credential from a map key.
    const digest = createHash('sha256').update(account.authCode).digest('hex').slice(0, 12)
    const key = [account.email, account.imap.host, String(account.imap.port), String(account.imap.secure), String(account.timeoutMs), digest].join('|')
    let session = this.sessions.get(key)
    if (session === undefined) {
      session = new ImapSession(
        {
          host: account.imap.host,
          port: account.imap.port,
          secure: account.imap.secure,
          user: account.email,
          pass: account.authCode,
          timeoutMs: account.timeoutMs,
        },
        this.idleMs,
      )
      this.sessions.set(key, session)
    }
    return session
  }

  /** Close every pooled connection (host unload, CLI exit). */
  async closeAll(): Promise<void> {
    for (const [email, generation] of this.generations) this.generations.set(email, generation + 1)
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    this.sentFolders.clear()
    await Promise.all(sessions.map((session) => session.retire()))
  }

  /** Resolve the Sent folder, auto-detecting once per account. */
  private async resolveSentFolder(
    client: Parameters<Parameters<ImapSession['run']>[0]>[0],
    account: Account,
  ): Promise<string> {
    if (account.sentFolder !== '') return account.sentFolder
    const cached = this.sentFolders.get(account.email)
    if (cached !== undefined) return cached
    const mailboxes = await listMailboxes(client, false)
    const found = pickSpecialFolder(mailboxes, 'sent')
    if (this.isCurrent(account)) this.sentFolders.set(account.email, found)
    return found
  }

  /** List mailboxes (folders) with optional message/unseen counts. */
  async folders(includeStatus = false, ref?: string): Promise<MailboxInfo[]> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    return session.run((client) => listMailboxes(client, includeStatus))
  }

  /** Count messages and unseen messages in one mailbox. */
  async count(mailbox: string, ref?: string): Promise<{ messages: number; unseen: number }> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    return session.run(async (client) => {
      const status = await client.status(mailbox, { messages: true, unseen: true })
      return {
        messages: typeof status.messages === 'number' ? status.messages : 0,
        unseen: typeof status.unseen === 'number' ? status.unseen : 0,
      }
    })
  }

  /** List the newest (or oldest) messages in a mailbox. */
  async listMessages(options: ListOptions, ref?: string): Promise<SearchResult> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    const preview = options.preview ?? account.previewInList
    const mailbox = options.mailbox.trim() === '' ? 'INBOX' : options.mailbox.trim()
    return session.run((client) =>
      withMailbox(client, mailbox, account.timeoutMs, async () => {
        const criteria: Record<string, unknown> = {}
        if (options.unseen) criteria.seen = false
        if (options.flagged) criteria.flagged = true
        if (Object.keys(criteria).length === 0) criteria.all = true
        const uids = await searchUids(client, criteria)
        // IMAP returns ascending UIDs; the newest messages are at the tail.
        const window = options.order === 'desc' ? uids.slice(-options.limit).reverse() : uids.slice(0, options.limit)
        const items = await fetchSummaries(
          client,
          window,
          { mailbox, preview, previewBytes: PREVIEW_BYTES },
          (part) => (preview ? decodePreviewPart(part) : ''),
        )
        return {
          mailbox,
          mode: 'server' as const,
          total: uids.length,
          truncated: uids.length > options.limit,
          items,
        }
      }),
    )
  }

  /** Search messages, falling back to an in-process filter for non-ASCII terms. */
  async searchMessages(query: SearchQuery, options: SearchOptions, ref?: string): Promise<SearchResult> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    const mailbox = query.mailbox.trim() === '' ? 'INBOX' : query.mailbox.trim()
    const { criteria, localOnly } = buildSearchCriteria(query)
    return session.run((client) =>
      withMailbox(client, mailbox, account.timeoutMs, async () => {
        /**
         * Scan a recent window in-process. Used for non-ASCII terms (QQ Mail's
         * SEARCH has no charset negotiation worth trusting) and as the fallback
         * below.
         */
        const scanLocal = async (): Promise<SearchResult> => {
          const all = await searchUids(client, { all: true })
          const recent = all.slice(-LOCAL_SEARCH_WINDOW)
          const summaries = await fetchSummaries(
            client,
            recent,
            { mailbox, preview: true, previewBytes: LOCAL_PREVIEW_BYTES },
            (part) => decodePreviewPart(part),
          )
          const matched = summaries.filter((summary) => matchesLocally(summary, query))
          const ordered = options.order === 'desc' ? [...matched].reverse() : matched
          return {
            mailbox,
            mode: 'local',
            total: matched.length,
            truncated: matched.length > options.limit || all.length > LOCAL_SEARCH_WINDOW,
            items: ordered.slice(0, options.limit),
          }
        }
        if (localOnly) return scanLocal()
        const uids = await searchUids(client, criteria)
        if (uids.length > 0) {
          const window = options.order === 'desc' ? uids.slice(-options.limit).reverse() : uids.slice(0, options.limit)
          const items = await fetchSummaries(
            client,
            window,
            { mailbox, preview: options.preview, previewBytes: PREVIEW_BYTES },
            (part) => (options.preview ? decodePreviewPart(part) : ''),
          )
          return {
            mailbox,
            mode: 'server' as const,
            total: uids.length,
            truncated: uids.length > options.limit,
            items,
          }
        }
        // A server search that matched nothing is only trustworthy for headers.
        // Providers store non-ASCII bodies MIME-encoded, so an ASCII term inside
        // a Chinese body is invisible to SEARCH — reporting "no matches" there
        // would be a silent false negative. Re-check locally for content
        // searches before answering.
        if (query.body === '' && query.text === '') {
          return { mailbox, mode: 'server' as const, total: 0, truncated: false, items: [] }
        }
        return scanLocal()
      }),
    )
  }

  /** Read one or more messages in full. */
  async readMessages(uids: readonly number[], options: ReadOptions, ref?: string): Promise<ReadResult> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    const mailbox = options.mailbox.trim() === '' ? 'INBOX' : options.mailbox.trim()
    const cap = account.maxParseMb * MB
    return session.run((client) =>
      withMailbox(client, mailbox, account.timeoutMs, async () => {
        const items: MessageDetail[] = []
        const errors: string[] = []
        for (const uid of uids) {
          try {
            const raw = await fetchRawSource(client, uid, cap + 1)
            if (raw.size > cap) {
              errors.push(
                '邮件 ' +
                  String(uid) +
                  ' 大小 ' +
                  formatSize(raw.size) +
                  ' 超过 maxParseMb（' +
                  String(account.maxParseMb) +
                  ' MB），已跳过；可在配置里调大 maxParseMb。',
              )
              continue
            }
            const parsed = await parseSource(raw.source, false)
            const detail = toDetail(parsed, uid, mailbox, {
              seen: raw.seen,
              flagged: raw.flagged,
              answered: false,
            }, options.html)
            if (options.markSeen && !raw.seen) {
              await storeFlags(client, [uid], ['\\Seen'], [])
              detail.seen = true
            }
            items.push(detail)
          } catch (error) {
            errors.push('读取邮件 ' + String(uid) + ' 失败：' + describeImapError(error))
          }
        }
        return { items, errors }
      }),
    )
  }

  /** Send a message and archive the Sent copy. */
  async send(input: SendInput, ref?: string): Promise<SendResult> {
    const account = this.accountOrThrow(ref)
    const recipients = [...input.to, ...input.cc, ...input.bcc].filter((entry) => entry.trim() !== '')
    if (recipients.length === 0) throw new Error('至少需要一个收件人（to / cc / bcc）。')
    if (input.subject.trim() === '' && input.text.trim() === '' && input.html.trim() === '') {
      throw new Error('邮件既没有主题也没有正文，已拒绝发送。')
    }
    const outgoing: OutgoingMessage = {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: input.attachments,
      inReplyTo: input.inReplyTo,
      references: input.references,
      saveSent: input.saveSent,
    }
    const composed = await composeMessage({ name: account.fromName, address: account.email }, outgoing)
    if (composed.size > account.maxSendMb * MB) {
      throw new Error(
        '邮件体积 ' +
          formatSize(composed.size) +
          ' 超过 maxSendMb（' +
          String(account.maxSendMb) +
          ' MB），已拒绝发送；可在配置里调大或去掉大附件。',
      )
    }
    if (!this.isCurrent(account)) throw new Error('邮箱配置已变更，请重试请求。')
    const endpoint: SmtpEndpoint = {
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      user: account.email,
      pass: account.authCode,
      timeoutMs: account.timeoutMs,
      requireTls: account.smtpRequireTls,
    }
    const result = await sendComposed(endpoint, composed)
    const saveSent = input.saveSent ?? account.saveSent
    if (!saveSent) return result
    try {
      const session = this.session(account)
      result.savedTo = await session.run(async (client) => {
        const folder = await this.resolveSentFolder(client, account)
        if (folder === '') return ''
        const appended = await appendMessage(client, folder, composed.raw)
        return appended ? folder : ''
      })
    } catch (error) {
      // The mail is already delivered; a failed archive must not look like a
      // failed send.
      result.saveError = describeImapError(error)
    }
    return result
  }

  /**
   * Download one attachment to disk.
   * @param uid - the message UID.
   * @param index - 1-based attachment index (as reported by `qqmail_read`).
   * @param mailbox - the mailbox holding the UID.
   * @param outDir - directory to write into (created when missing).
   */
  async downloadAttachment(
    uid: number,
    index: number,
    mailbox: string,
    outDir: string,
    ref?: string,
  ): Promise<DownloadResult> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    const target = mailbox.trim() === '' ? 'INBOX' : mailbox.trim()
    return session.run((client) =>
      withMailbox(client, target, account.timeoutMs, async () => {
        const raw = await fetchRawSource(client, uid, account.maxParseMb * MB + 1)
        const parsed = await parseSource(raw.source, false)
        const attachments = parsed.parsed.attachments ?? []
        if (attachments.length === 0) {
          throw new Error('邮件 ' + String(uid) + ' 没有附件。')
        }
        if (index < 1 || index > attachments.length) {
          throw new Error(
            '附件序号 ' +
              String(index) +
              ' 超出范围：该邮件共有 ' +
              String(attachments.length) +
              ' 个附件（序号 1–' +
              String(attachments.length) +
              '）。',
          )
        }
        const attachment = attachments[index - 1]
        if (attachment === undefined) throw new Error('附件 ' + String(index) + ' 不存在。')
        const filename = safeFilename(attachment.filename ?? '', 'attachment-' + String(index))
        await mkdir(outDir, { recursive: true })
        const finalPath = await uniquePath(path.join(outDir, filename))
        await writeFile(finalPath, attachment.content)
        return {
          path: finalPath,
          filename: path.basename(finalPath),
          size: attachment.content.length,
          contentType: attachment.contentType ?? 'application/octet-stream',
        }
      }),
    )
  }

  /** Add/remove flags on messages. */
  async mark(
    uids: readonly number[],
    mailbox: string,
    actions: { seen?: boolean; flagged?: boolean },
    ref?: string,
  ): Promise<{ changed: number; applied: string[] }> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    const target = mailbox.trim() === '' ? 'INBOX' : mailbox.trim()
    const add: string[] = []
    const remove: string[] = []
    if (actions.seen === true) add.push('\\Seen')
    if (actions.seen === false) remove.push('\\Seen')
    if (actions.flagged === true) add.push('\\Flagged')
    if (actions.flagged === false) remove.push('\\Flagged')
    if (add.length === 0 && remove.length === 0) {
      throw new Error('没有可执行的标记动作：至少给出 seen 或 flagged。')
    }
    return session.run((client) =>
      withMailbox(client, target, account.timeoutMs, async () => {
        await storeFlags(client, uids, add, remove)
        return { changed: uids.length, applied: [...add, ...remove.map((flag) => '去掉 ' + flag)] }
      }),
    )
  }

  /** Move messages to another mailbox. */
  async move(uids: readonly number[], from: string, destination: string, ref?: string): Promise<{ moved: number }> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    const source = from.trim() === '' ? 'INBOX' : from.trim()
    if (destination.trim() === '') throw new Error('移动目标文件夹不能为空（destination）。')
    return session.run((client) =>
      withMailbox(client, source, account.timeoutMs, async () => {
        const ok = await moveMessages(client, uids, destination.trim())
        if (!ok) throw new Error('服务器拒绝了移动操作。')
        return { moved: uids.length }
      }),
    )
  }

  /**
   * Delete messages.
   * @param permanent - false = move to Trash (default), true = `\Deleted` + EXPUNGE.
   */
  async remove(
    uids: readonly number[],
    mailbox: string,
    permanent: boolean,
    ref?: string,
  ): Promise<{ count: number; mode: 'trash' | 'permanent'; trashFolder: string }> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    const target = mailbox.trim() === '' ? 'INBOX' : mailbox.trim()
    return session.run((client) =>
      withMailbox(client, target, account.timeoutMs, async () => {
        const folder = permanent ? '' : await this.resolveSentFolderKind(client, account, 'trash')
        const outcome = await deleteMessages(client, uids, folder, permanent)
        return {
          count: uids.length,
          mode: outcome.permanent ? ('permanent' as const) : ('trash' as const),
          trashFolder: folder,
        }
      }),
    )
  }

  /** Resolve a special folder other than Sent (trash/drafts/junk). */
  private async resolveSentFolderKind(
    client: Parameters<Parameters<ImapSession['run']>[0]>[0],
    account: Account,
    kind: 'trash' | 'drafts' | 'junk',
  ): Promise<string> {
    const cached = this.sentFolders.get(account.email + ':' + kind)
    if (cached !== undefined) return cached
    const mailboxes = await listMailboxes(client, false)
    const found = pickSpecialFolder(mailboxes, kind)
    if (this.isCurrent(account)) this.sentFolders.set(account.email + ':' + kind, found)
    return found
  }

  /** Connect-and-authenticate probe for both protocols. */
  async probe(ref?: string): Promise<ProbeResult> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    const smtp: SmtpEndpoint = {
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      user: account.email,
      pass: account.authCode,
      timeoutMs: account.timeoutMs,
      requireTls: account.smtpRequireTls,
    }
    const result: ProbeResult = {
      ok: false,
      imapOk: false,
      smtpOk: false,
      imapError: '',
      smtpError: '',
      capabilities: '',
      mailboxCount: 0,
      sentFolder: '',
    }
    try {
      const imap = await session.run(async (client) => {
        const mailboxes = await listMailboxes(client, false)
        return {
          count: mailboxes.length,
          sent: pickSpecialFolder(mailboxes, 'sent'),
          capabilities: typeof client.capabilities === 'object' && client.capabilities !== null
            ? Object.keys(client.capabilities).slice(0, 12).join(' ')
            : '',
        }
      })
      result.imapOk = true
      result.mailboxCount = imap.count
      result.sentFolder = imap.sent
      result.capabilities = imap.capabilities
    } catch (error) {
      result.imapError = describeImapError(error)
    }
    const smtpResult = await verifySmtp(smtp)
    result.smtpOk = smtpResult.ok
    result.smtpError = smtpResult.error
    result.ok = result.imapOk && result.smtpOk
    return result
  }

  /** Attachment metadata for one message (without downloading bodies). */
  async attachments(uid: number, mailbox: string, ref?: string): Promise<AttachmentMeta[]> {
    const result = await this.readMessages([uid], { mailbox, html: false, markSeen: false }, ref)
    const item = result.items[0]
    if (item === undefined) {
      throw new Error(result.errors[0] ?? ('读取邮件 ' + String(uid) + ' 失败。'))
    }
    return item.attachments
  }

  /** Summaries for an explicit UID list (used by reply building and tests). */
  async summaries(uids: readonly number[], mailbox: string, preview = false, ref?: string): Promise<MessageSummary[]> {
    const account = this.accountOrThrow(ref)
    const session = this.session(account)
    const target = mailbox.trim() === '' ? 'INBOX' : mailbox.trim()
    return session.run((client) =>
      withMailbox(client, target, account.timeoutMs, () =>
        fetchSummaries(
          client,
          uids,
          { mailbox: target, preview, previewBytes: PREVIEW_BYTES },
          (part) => (preview ? decodePreviewPart(part) : ''),
        ),
      ),
    )
  }
}

/** Find a non-colliding path by appending `-1`, `-2`, … before the extension. */
async function uniquePath(candidate: string): Promise<string> {
  const exists = async (file: string): Promise<boolean> => {
    try {
      await stat(file)
      return true
    } catch {
      return false
    }
  }
  if (!(await exists(candidate))) return candidate
  const dir = path.dirname(candidate)
  const ext = path.extname(candidate)
  const base = path.basename(candidate, ext)
  for (let index = 1; index < 1000; index += 1) {
    const next = path.join(dir, base + '-' + String(index) + ext)
    if (!(await exists(next))) return next
  }
  return path.join(dir, base + '-' + String(Date.now()) + ext)
}

/** Normalize a raw address list (re-exported for callers that build replies). */
export { toAddressList }

/** Fill the query defaults used by the tools and the CLI. */
export function normalizeQuery(input: Partial<SearchQuery>, mailboxDefault = 'INBOX'): SearchQuery {
  return {
    mailbox: (input.mailbox ?? mailboxDefault).trim() === '' ? mailboxDefault : (input.mailbox ?? mailboxDefault),
    from: input.from ?? '',
    to: input.to ?? '',
    subject: input.subject ?? '',
    body: input.body ?? '',
    text: input.text ?? '',
    since: input.since ?? '',
    before: input.before ?? '',
    unseen: input.unseen === true,
    flagged: input.flagged === true,
    larger: typeof input.larger === 'number' && input.larger > 0 ? Math.floor(input.larger) : 0,
    smaller: typeof input.smaller === 'number' && input.smaller > 0 ? Math.floor(input.smaller) : 0,
  }
}
