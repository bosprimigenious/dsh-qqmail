/**
 * dsh-qqmail — IMAP layer.
 *
 * Owns one lazily-opened connection per account, serializes commands on it, and
 * closes it after an idle period so a short-lived CLI run does not leave a
 * socket behind. Nothing above this module touches ImapFlow directly, which
 * keeps the two-callers-one-connection rule (mailboxes are per-connection state
 * in IMAP) impossible to break by accident.
 *
 * Why a serial queue instead of parallel commands: IMAP has a single selected
 * mailbox per connection, so `getMailboxLock` on the same client would serialize
 * anyway — doing it here means a failed command can never leave the connection
 * in an unknown selected state for the next caller.
 */

import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow'

import { isoDate, parseDate, toAddressList } from './mime.ts'
import type {
  MailboxInfo,
  MessageSummary,
  SearchQuery,
  SearchResult,
} from './types.ts'

/** Endpoint + credentials for one IMAP server. */
export interface ImapEndpoint {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  /** Budget for connect + greeting (ms). */
  timeoutMs: number
}

/** Default idle period before the pooled connection is closed (ms). */
export const DEFAULT_IDLE_MS = 60_000

/** Special folders the plugin can resolve from the server's mailbox list. */
export type SpecialFolderKind = 'sent' | 'drafts' | 'trash' | 'junk'

/** Draft/trash/junk detection, by SPECIAL-USE then by name. */
const SPECIAL_FOLDERS: Record<SpecialFolderKind, { flags: string[]; names: RegExp }> = {
  sent: { flags: ['\\Sent'], names: /^(sent|sent messages|sent items|已发送|已发送邮件|发件箱)$/i },
  drafts: { flags: ['\\Drafts'], names: /^(drafts?|草稿|草稿箱)$/i },
  trash: {
    flags: ['\\Trash'],
    names: /^(trash|deleted|deleted messages|deleted items|bin|已删除|已删除邮件|废件箱|回收站)$/i,
  },
  junk: { flags: ['\\Junk', '\\Spam'], names: /^(junk|junk e-?mail|spam|垃圾邮件|垃圾箱)$/i },
}

/**
 * Turn an ImapFlow failure into something a user can act on.
 *
 * The authorization-code trap is the one that bites everybody: QQ Mail rejects
 * the account password with a bare "Authentication failed", and the fix (enable
 * IMAP/SMTP and generate a 16-character authorization code) is not guessable
 * from the server response.
 * @param error - whatever the command rejected with.
 * @returns a Chinese explanation with the usual fixes.
 */
export function describeImapError(error: unknown): string {
  // ImapFlow wraps server text differently per failure: `message` is often the
  // generic "Command failed", while the actionable part lives in `responseText`
  // ("Authentication failed") or `serverResponseCode` ("AUTHENTICATIONFAILED").
  // Reading only `message` turns every auth problem into a dead end for the user.
  const detail = error as {
    message?: unknown
    code?: unknown
    responseText?: unknown
    serverResponseCode?: unknown
    name?: unknown
    authenticationFailed?: unknown
  } | null
  const parts = [
    typeof detail?.message === 'string' ? detail.message : '',
    typeof detail?.responseText === 'string' ? detail.responseText : '',
    typeof detail?.serverResponseCode === 'string' ? detail.serverResponseCode : '',
    typeof detail?.name === 'string' ? detail.name : '',
    typeof detail?.code === 'string' ? detail.code : '',
    detail?.authenticationFailed === true ? 'AuthenticationFailure' : '',
  ].filter((entry) => entry !== '')
  const raw = parts.length > 0 ? parts.join(' | ') : String(error)
  if (/AuthenticationFailure|AUTHENTICATIONFAILED|authentication failed|LOGIN failed|Invalid credentials/i.test(raw)) {
    return (
      'IMAP 认证失败：QQ 邮箱不收账号密码，必须在网页版「设置 → 账号 → IMAP/SMTP服务」开启服务并生成 16 位**授权码**，' +
      '把授权码（不是 QQ 密码）填进 qqmail_config 的 authCode。原始错误：' + raw
    )
  }
  if (/CONNECT_TIMEOUT|ETIMEDOUT|timeout/i.test(raw)) {
    return (
      'IMAP 连接超时：检查网络、端口（QQ 邮箱 IMAP 是 imap.qq.com:993 SSL）与代理设置。原始错误：' + raw
    )
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return '无法解析 IMAP 服务器地址（DNS 失败）：检查 imapHost 拼写与网络。原始错误：' + raw
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return 'IMAP 连接被拒绝：端口不对或被防火墙拦截。QQ 邮箱 IMAP 用 993（SSL），SMTP 用 465（SSL）。原始错误：' + raw
  }
  if (/certificate|self signed|CERT_/i.test(raw)) {
    return 'TLS 证书校验失败：若用的是企业自建服务器，确认证书链是否完整（插件不放宽证书校验）。原始错误：' + raw
  }
  return raw
}

/** Raw shape of one IMAP message as far as this module reads it. */
interface RawMessage extends Partial<FetchMessageObject> {
  uid: number
  seq: number
}

/** Options for {@link fetchSummaries}. */
export interface SummaryOptions {
  mailbox: string
  /** Fetch a short body preview alongside the headers (slower). */
  preview: boolean
  /** Max bytes of raw source requested per message when previewing. */
  previewBytes: number
}

/** One lazily-connected, serialized IMAP session. */
export class ImapSession {
  private client: ImapFlow | null = null
  private opening: Promise<ImapFlow> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  /** Set by {@link run} while a command is in flight (suppresses idle close). */
  private busy = false
  private retired = false

  constructor(
    private readonly endpoint: ImapEndpoint,
    private readonly idleMs: number = DEFAULT_IDLE_MS,
  ) {}

  /** True while a pooled connection is open and authenticated. */
  get connected(): boolean {
    return this.client !== null && this.client.usable
  }

  /**
   * Run one operation with exclusive use of the connection.
   *
   * Operations are serialized; a failure never poisons the queue, and a dead
   * socket is dropped so the next caller reconnects instead of reusing a corpse.
   * @param fn - receives the live client; must not keep a reference to it.
   */
  async run<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    if (this.retired) throw new Error('邮箱配置已变更，请重试请求。')
    const task = this.queue.then(
      () => this.execute(fn),
      () => this.execute(fn),
    )
    this.queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async execute<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = await this.ensure()
    this.busy = true
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    try {
      return await fn(client)
    } catch (error) {
      if (!client.usable) await this.drop()
      throw error
    } finally {
      this.busy = false
      this.armIdle()
    }
  }

  private async ensure(): Promise<ImapFlow> {
    const current = this.client
    if (current !== null && current.usable) return current
    if (this.opening === null) this.opening = this.open()
    try {
      return await this.opening
    } finally {
      this.opening = null
    }
  }

  private async open(): Promise<ImapFlow> {
    await this.drop()
    const { host, port, secure, user, pass, timeoutMs } = this.endpoint
    const client = new ImapFlow({
      host,
      port,
      secure,
      auth: { user, pass },
      logger: false,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      // Transfers (a 20 MB attachment, a slow fetch) legitimately outlive the
      // connect budget, so the socket watchdog is deliberately more generous.
      socketTimeout: Math.max(timeoutMs, 120_000),
      clientInfo: { name: 'dsh-qqmail', version: '0.1.0' },
    })
    // ImapFlow emits 'error' on socket faults. Without a listener Node turns a
    // transient network blip into an uncaught exception that kills the host.
    client.on('error', () => undefined)
    await client.connect()
    this.client = client
    return client
  }

  /** Schedule the idle close (never while a command is running). */
  private armIdle(): void {
    if (this.retired || this.busy || this.idleMs <= 0) return
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.busy) void this.drop()
    }, this.idleMs)
    // Never keep a CLI process alive just to close an idle socket.
    this.idleTimer.unref?.()
  }

  /** Stop accepting new work, drain existing work (including opening), then close. */
  async retire(): Promise<void> {
    this.retired = true
    await this.queue
    await this.drop()
  }

  /** Close the pooled connection now (idempotent, never throws). */
  async drop(): Promise<void> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const client = this.client
    this.client = null
    if (client === null) return
    try {
      if (client.usable) await client.logout()
    } catch {
      // Managed by close() below.
    }
    try {
      client.close()
    } catch {
      // Already gone.
    }
  }
}

/** Select a mailbox for the duration of one callback. */
export async function withMailbox<T>(
  client: ImapFlow,
  mailbox: string,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(mailbox, { acquireTimeout: Math.max(10_000, timeoutMs) })
  try {
    return await fn()
  } finally {
    lock.release()
  }
}

/** Read every message out of a fetch generator. */
async function collect(generator: AsyncGenerator<RawMessage, unknown, unknown>): Promise<RawMessage[]> {
  const out: RawMessage[] = []
  for await (const item of generator) out.push(item)
  return out
}

/** Normalize one mailbox list entry. */
function toMailboxInfo(entry: ListResponse, messages: number, unseen: number): MailboxInfo {
  const flags = entry.flags instanceof Set ? [...entry.flags] : []
  return {
    path: entry.path,
    name: entry.name !== '' ? entry.name : entry.path,
    specialUse: entry.specialUse ?? '',
    flags,
    subscribed: entry.subscribed !== false,
    messages,
    unseen,
  }
}

/**
 * List mailboxes.
 * @param client - live IMAP client.
 * @param includeStatus - also ask STATUS for message/unseen counts (extra round trip each).
 */
export async function listMailboxes(client: ImapFlow, includeStatus: boolean): Promise<MailboxInfo[]> {
  const entries = await client.list()
  const out: MailboxInfo[] = []
  for (const entry of entries) {
    const flags = entry.flags instanceof Set ? [...entry.flags] : []
    // \Noselect containers exist only to hold children and cannot be opened.
    if (flags.includes('\\Noselect')) continue
    let messages = -1
    let unseen = -1
    if (includeStatus) {
      try {
        const status = await client.status(entry.path, { messages: true, unseen: true })
        messages = typeof status.messages === 'number' ? status.messages : -1
        unseen = typeof status.unseen === 'number' ? status.unseen : -1
      } catch {
        // Some servers refuse STATUS on certain folders; counts stay unknown.
      }
    }
    out.push(toMailboxInfo(entry, messages, unseen))
  }
  return out
}

/**
 * Pick the mailbox path for a special folder.
 * @param mailboxes - the full mailbox list.
 * @param kind - which special folder to resolve.
 * @returns the path, or '' when the server exposes none (e.g. no Sent folder).
 */
export function pickSpecialFolder(mailboxes: readonly MailboxInfo[], kind: SpecialFolderKind): string {
  const rule = SPECIAL_FOLDERS[kind]
  for (const mailbox of mailboxes) {
    if (mailbox.specialUse !== '' && rule.flags.includes(mailbox.specialUse)) return mailbox.path
  }
  for (const mailbox of mailboxes) {
    if (rule.names.test(mailbox.name.trim())) return mailbox.path
  }
  // A nested folder such as `INBOX.Sent` still counts when nothing else matched.
  for (const mailbox of mailboxes) {
    if (rule.names.test(mailbox.path.split(/[/.]/).pop()?.trim() ?? '')) return mailbox.path
  }
  return ''
}

/** Count all and unseen messages in one mailbox. */
export async function countMailbox(
  client: ImapFlow,
  mailbox: string,
  timeoutMs: number,
): Promise<{ messages: number; unseen: number }> {
  try {
    const status = await client.status(mailbox, { messages: true, unseen: true })
    return {
      messages: typeof status.messages === 'number' ? status.messages : 0,
      unseen: typeof status.unseen === 'number' ? status.unseen : 0,
    }
  } catch {
    void timeoutMs
    return { messages: 0, unseen: 0 }
  }
}

/**
 * Build the server-side SEARCH criteria for a query.
 *
 * Non-ASCII terms are reported as `localOnly` and dropped instead of being sent:
 * RFC 3501 SEARCH has no charset negotiation QQ Mail honours in practice, so a
 * Chinese keyword would come back as a silent zero-match — the caller filters a
 * recent window in-process instead and says so in the result.
 * @param query - the caller's criteria.
 */
export function buildSearchCriteria(query: SearchQuery): {
  criteria: Record<string, unknown>
  localOnly: boolean
} {
  const criteria: Record<string, unknown> = {}
  let localOnly = false
  const assign = (key: string, value: string): void => {
    if (value === '') return
    if (/[^\x20-\x7e]/.test(value)) {
      localOnly = true
      return
    }
    criteria[key] = value
  }
  assign('from', query.from)
  assign('to', query.to)
  assign('subject', query.subject)
  assign('body', query.body)
  assign('text', query.text)
  // Local midnight for a date-only value, which is what a user means by "since".
  const since = parseDate(query.since)
  if (since !== undefined) criteria.since = since
  const before = parseDate(query.before)
  if (before !== undefined) criteria.before = before
  if (query.unseen) criteria.seen = false
  if (query.flagged) criteria.flagged = true
  if (query.larger > 0) criteria.larger = query.larger
  if (query.smaller > 0) criteria.smaller = query.smaller
  if (Object.keys(criteria).length === 0) criteria.all = true
  return { criteria, localOnly }
}

/** True when a header value matches a case-insensitive substring. */
function headerMatches(haystack: string, needle: string): boolean {
  if (needle === '') return true
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/** The subset of ImapFlow's parsed BODYSTRUCTURE node this module reads. */
interface StructureNode {
  type?: unknown
  parameters?: unknown
  id?: unknown
  childNodes?: unknown
}

/** True when a part carries a `name`/`filename` parameter. */
function hasNameParameter(node: StructureNode): boolean {
  const params = node.parameters
  if (params === undefined || params === null) return false
  if (params instanceof Map) return params.has('name') || params.has('filename')
  if (typeof params === 'object') {
    return Object.keys(params as Record<string, unknown>).some((key) => {
      const lower = key.toLowerCase()
      return lower === 'name' || lower === 'filename'
    })
  }
  return false
}

/**
 * True when a leaf part looks like an attachment.
 *
 * ImapFlow's parsed BODYSTRUCTURE does NOT expose `content-disposition` (the
 * `disposition` field exists only on `download()` metadata, parsed from the real
 * part headers), so the classic "disposition === attachment" test is impossible
 * here. The structural equivalent: a leaf that is not a nameless text body, and
 * that has no Content-ID (an inline part is referenced from the HTML body).
 */
export function isAttachmentPart(structure: unknown): boolean {
  if (typeof structure !== 'object' || structure === null) return false
  const node = structure as StructureNode
  const type = typeof node.type === 'string' ? node.type.toLowerCase() : ''
  if (type === '' || type.startsWith('multipart/')) return false
  if (type.startsWith('text/') && !hasNameParameter(node)) return false
  if (typeof node.id === 'string' && node.id.trim() !== '') return false
  return true
}

/** True when a message structure carries a real attachment part. */
export function hasAttachmentPart(structure: unknown): boolean {
  if (typeof structure !== 'object' || structure === null) return false
  const node = structure as StructureNode
  if (Array.isArray(node.childNodes)) {
    return node.childNodes.some((child) => hasAttachmentPart(child))
  }
  return isAttachmentPart(node)
}

/** Project a raw fetch result onto a MessageSummary. */
export function toSummary(
  message: RawMessage,
  mailbox: string,
  previewText: string,
): MessageSummary {
  const envelope = message.envelope ?? {}
  const flags = message.flags instanceof Set ? message.flags : new Set<string>()
  const dateValue = envelope.date instanceof Date ? envelope.date : undefined
  return {
    uid: message.uid,
    mailbox,
    subject: envelope.subject !== undefined && envelope.subject !== '' ? envelope.subject : '(无主题)',
    from: toAddressList(envelope.from),
    to: toAddressList(envelope.to),
    date: isoDate(dateValue),
    size: typeof message.size === 'number' ? message.size : 0,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachmentPart(message.bodyStructure),
    preview: previewText,
    messageId: envelope.messageId ?? '',
  }
}

/** Raw fields requested for a header-only fetch. */
function headerQuery(preview: boolean, previewBytes: number): Record<string, unknown> {
  const query: Record<string, unknown> = {
    uid: true,
    envelope: true,
    flags: true,
    size: true,
    // Needed to report `hasAttachments` without downloading anything.
    bodyStructure: true,
  }
  // The first MIME part is the plain-text or HTML body in every layout QQ Mail
  // produces, so this peek is enough for a list preview without downloading
  // attachments. Truncated input still parses well enough to show a sentence.
  if (preview) query.bodyParts = [{ key: '1', maxLength: previewBytes }]
  return query
}

/**
 * Fetch summaries for an explicit UID list (order preserved as given).
 * @param client - live IMAP client.
 * @param uids - UIDs to fetch; an empty list short-circuits.
 * @param options - mailbox and preview settings.
 * @param decode - preview decoder (kept injectable so this module stays parser-free).
 */
export async function fetchSummaries(
  client: ImapFlow,
  uids: readonly number[],
  options: SummaryOptions,
  decode: (raw: Buffer | undefined, uid: number) => string,
): Promise<MessageSummary[]> {
  if (uids.length === 0) return []
  const rows = await collect(
    client.fetch([...uids], headerQuery(options.preview, options.previewBytes) as never, {
      uid: true,
    }) as AsyncGenerator<RawMessage, unknown, unknown>,
  )
  const byUid = new Map<number, RawMessage>()
  for (const row of rows) byUid.set(row.uid, row)
  const out: MessageSummary[] = []
  // Iterate the requested order, not the server's, so "newest first" survives.
  for (const uid of uids) {
    const row = byUid.get(uid)
    if (row === undefined) continue
    const part = row.bodyParts instanceof Map ? row.bodyParts.get('1') : undefined
    out.push(toSummary(row, options.mailbox, decode(part, uid)))
  }
  return out
}

/**
 * Server-side UID search.
 * @returns ascending UIDs (oldest first), as IMAP returns them.
 */
export async function searchUids(
  client: ImapFlow,
  criteria: Record<string, unknown>,
): Promise<number[]> {
  const result = await client.search(criteria as never, { uid: true })
  if (!Array.isArray(result)) return []
  return result
}

/** Fetch the raw source of one message. */
export async function fetchRawSource(
  client: ImapFlow,
  uid: number,
  maxBytes: number,
): Promise<{ source: Buffer; size: number; seen: boolean; flagged: boolean }> {
  const message = (await client.fetchOne(
    String(uid),
    { uid: true, source: { maxLength: maxBytes }, flags: true, size: true } as never,
    { uid: true },
  )) as RawMessage | false | undefined
  if (message === false || message === undefined) {
    throw new Error('邮件不存在（uid ' + String(uid) + '）：可能已被移动或删除。')
  }
  const flags = message.flags instanceof Set ? message.flags : new Set<string>()
  return {
    source: message.source ?? Buffer.alloc(0),
    size: typeof message.size === 'number' ? message.size : 0,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
  }
}

/** Fetch raw sources for several messages in one batch. */
export async function fetchRawSources(
  client: ImapFlow,
  uids: readonly number[],
  maxBytes: number,
): Promise<Map<number, Buffer>> {
  const out = new Map<number, Buffer>()
  if (uids.length === 0) return out
  const rows = await collect(
    client.fetch([...uids], { uid: true, source: { maxLength: maxBytes } } as never, {
      uid: true,
    }) as AsyncGenerator<RawMessage, unknown, unknown>,
  )
  for (const row of rows) out.set(row.uid, row.source ?? Buffer.alloc(0))
  return out
}

/** Add and/or remove flags on one or more messages. */
export async function storeFlags(
  client: ImapFlow,
  uids: readonly number[],
  add: readonly string[],
  remove: readonly string[],
): Promise<void> {
  if (uids.length === 0) return
  if (add.length > 0) await client.messageFlagsAdd([...uids], [...add], { uid: true })
  if (remove.length > 0) await client.messageFlagsRemove([...uids], [...remove], { uid: true })
}

/** Move messages to another mailbox; returns true when the server confirmed. */
export async function moveMessages(
  client: ImapFlow,
  uids: readonly number[],
  destination: string,
): Promise<boolean> {
  if (uids.length === 0) return true
  const result = await client.messageMove([...uids], destination, { uid: true })
  return result !== false
}

/**
 * Delete messages.
 *
 * Default is a move into the Trash folder, because a bare `\Deleted` + EXPUNGE
 * is irreversible and QQ Mail does not always advertise UIDPLUS — an error
 * halfway through an expunge can leave a mailbox in a half-deleted state that no
 * client can repair. Permanent deletion is a separate, explicit intent.
 * @param client - live IMAP client.
 * @param uids - messages to delete.
 * @param trashFolder - Trash mailbox path ('' = not available).
 * @param permanent - when true, mark `\Deleted` and expunge.
 */
export async function deleteMessages(
  client: ImapFlow,
  uids: readonly number[],
  trashFolder: string,
  permanent: boolean,
): Promise<{ moved: boolean; permanent: boolean }> {
  if (uids.length === 0) return { moved: false, permanent: false }
  if (!permanent) {
    if (trashFolder === '') {
      throw new Error('未找到「已删除」文件夹，无法安全删除；如需彻底删除请显式传 permanent: true。')
    }
    const moved = await moveMessages(client, uids, trashFolder)
    return { moved, permanent: false }
  }
  await client.messageDelete([...uids], { uid: true })
  return { moved: false, permanent: true }
}

/** Append a raw message to a mailbox (used for the Sent copy). */
export async function appendMessage(
  client: ImapFlow,
  mailbox: string,
  raw: Buffer,
): Promise<boolean> {
  const result = await client.append(mailbox, raw, ['\\Seen'])
  return result !== false
}

/** Probe the connection: connect, list mailboxes, resolve the Sent folder. */
export async function probeImap(
  session: ImapSession,
): Promise<{ ok: boolean; error: string; capabilities: string; mailboxCount: number; sentFolder: string }> {
  try {
    return await session.run(async (client) => {
      const mailboxes = await listMailboxes(client, false)
      return {
        ok: true,
        error: '',
        capabilities: '',
        mailboxCount: mailboxes.length,
        sentFolder: pickSpecialFolder(mailboxes, 'sent'),
      }
    })
  } catch (error) {
    return {
      ok: false,
      error: describeImapError(error),
      capabilities: '',
      mailboxCount: 0,
      sentFolder: '',
    }
  }
}

/** Exposed for the search layer and the tests. */
export type { SearchQuery, SearchResult }
