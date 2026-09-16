/**
 * dsh-qqmail — tool specifications.
 *
 * One plain-data definition per tool, free of any harness import, so the same
 * handler backs all three surfaces this plugin ships:
 *   - the DSH host tools (`qqmail_*`, wrapped in tools.ts),
 *   - the `qqmail` CLI (cli.ts),
 *   - the `qqmail-mcp` stdio server (mcp-server.ts, for other agents).
 *
 * Every handler resolves to `{ ok, message, data? }`: `message` is the short
 * human/agent-facing text and `data` carries the structured payload. Callers
 * decide how to show them, which is what keeps the three surfaces from drifting.
 */

import { stat } from 'node:fs/promises'
import path from 'node:path'

import type { MailService } from './mail.ts'
import { normalizeQuery } from './mail.ts'
import { formatAddress, formatSize, localDateTime, safeFilename, truncate } from './core/mime.ts'
import { PRESET_IDS, PRESETS } from './core/presets.ts'
import type { ParamSpec } from './core/schema.ts'
import type { MailboxInfo, MessageDetail, MessageSummary, PresetId } from './core/types.ts'
import type { MailStore } from './store.ts'

/** Result shape shared by every tool. */
export interface SpecResult {
  ok: boolean
  message: string
  /** Lossless-JSON structured payload (never contains the authorization code). */
  data?: unknown
}

/** Dependencies a spec needs to run. */
export interface SpecContext {
  service: MailService
  store: MailStore
  /** Called when a config change alters the tool roster (the readOnly switch). */
  onConfigChanged?: () => void
  /** Directory attachments land in when the caller names none. */
  workspaceDir: string
}

/** One tool definition plus its handler. */
export interface ToolSpec {
  name: string
  description: string
  parameters: ParamSpec
  /** True for tools that change state in the mailbox (gated by readOnly). */
  write: boolean
  handler: (args: Record<string, unknown>, ctx: SpecContext) => Promise<SpecResult>
}

/** Tools that only exist when the readOnly switch is off. */
export const WRITE_TOOL_NAMES: readonly string[] = [
  'qqmail_send',
  'qqmail_reply',
  'qqmail_mark',
  'qqmail_move',
  'qqmail_delete',
]

/* ------------------------------------------------------------------ */
/* Argument coercion                                                    */
/* ------------------------------------------------------------------ */

/** A trimmed string argument, or the fallback. */
function str(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : fallback
}

/** A string argument with internal whitespace preserved (bodies, signatures). */
function raw(args: Record<string, unknown>, key: string, fallback = ''): string {
  const value = args[key]
  return typeof value === 'string' ? value : fallback
}

/** A boolean argument, or the fallback when absent. */
function bool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key]
  return typeof value === 'boolean' ? value : fallback
}

/** An optional boolean (undefined when the caller said nothing). */
function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  return typeof value === 'boolean' ? value : undefined
}

/** A clamped integer argument. */
function int(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/** A string-array argument (also accepts one comma-separated string). */
function list(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter((entry) => entry !== '')
  }
  if (typeof value === 'string') {
    return value.split(/[,\s]+/).map((entry) => entry.trim()).filter((entry) => entry !== '')
  }
  return []
}

/** A required UID list, merging the singular and plural arguments. */
function uids(args: Record<string, unknown>): number[] {
  const out: number[] = []
  const single = args.uid
  if (typeof single === 'number' && Number.isFinite(single)) out.push(Math.floor(single))
  if (Array.isArray(args.uids)) {
    for (const entry of args.uids) {
      if (typeof entry === 'number' && Number.isFinite(entry)) out.push(Math.floor(entry))
    }
  }
  return [...new Set(out)]
}

/** A preset id, or undefined when the argument is absent/unknown. */
function presetOf(args: Record<string, unknown>): PresetId | undefined {
  const value = args.preset
  return typeof value === 'string' && (PRESET_IDS as readonly string[]).includes(value)
    ? (value as PresetId)
    : undefined
}

/** Wrap a handler so a thrown error becomes an `ok: false` result. */
async function guard(fn: () => Promise<SpecResult>): Promise<SpecResult> {
  try {
    return await fn()
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                    */
/* ------------------------------------------------------------------ */

/** One list line for the agent-facing message. */
export function summaryLine(summary: MessageSummary): string {
  const flags: string[] = []
  if (!summary.seen) flags.push('未读')
  if (summary.flagged) flags.push('星标')
  if (summary.hasAttachments) flags.push('附件')
  const badge = flags.length > 0 ? '[' + flags.join('·') + '] ' : ''
  const who = formatAddress(summary.from[0] ?? { name: '', address: '' })
  const when = localDateTime(summary.date === '' ? undefined : new Date(summary.date))
  const size = summary.size > 0 ? ' · ' + formatSize(summary.size) : ''
  const preview = summary.preview !== '' ? '\n      ' + truncate(summary.preview, 100) : ''
  return (
    '  uid ' +
    String(summary.uid).padStart(5) +
    '  ' +
    when +
    '  ' +
    badge +
    who +
    '\n      ' +
    truncate(summary.subject, 90) +
    size +
    preview
  )
}

/** Render a search/list result as text. */
export function renderList(result: { mailbox: string; mode: string; total: number; truncated: boolean; items: MessageSummary[] }): string {
  if (result.items.length === 0) {
    return '「' + result.mailbox + '」里没有匹配的邮件。'
  }
  const head =
    '「' +
    result.mailbox +
    '」匹配 ' +
    String(result.total) +
    ' 封，返回 ' +
    String(result.items.length) +
    ' 封（' +
    (result.mode === 'server' ? '服务器端搜索' : '本地窗口过滤，仅供中文关键词兜底') +
    '）' +
    (result.truncated ? '，已截断' : '') +
    '：'
  return head + '\n' + result.items.map(summaryLine).join('\n')
}

/** Render one mailbox line. */
function mailboxLine(mailbox: MailboxInfo): string {
  const counts =
    mailbox.messages >= 0
      ? '（' + String(mailbox.messages) + ' 封' + (mailbox.unseen > 0 ? '，' + String(mailbox.unseen) + ' 未读' : '') + '）'
      : ''
  const special = mailbox.specialUse !== '' ? ' ' + mailbox.specialUse : ''
  return '  ' + mailbox.path + counts + special
}

/** Render one full message as the agent-facing text. */
export function renderDetail(detail: MessageDetail, maxBodyChars: number): string {
  const lines: string[] = []
  lines.push('uid ' + String(detail.uid) + '　主题：' + detail.subject)
  lines.push('发件人：' + (detail.from.map(formatAddress).join(', ') || '(未知)'))
  lines.push('收件人：' + (detail.to.map(formatAddress).join(', ') || '(无)'))
  if (detail.cc.length > 0) lines.push('抄送：' + detail.cc.map(formatAddress).join(', '))
  lines.push('时间：' + localDateTime(detail.date === '' ? undefined : new Date(detail.date)))
  lines.push('状态：' + (detail.seen ? '已读' : '未读') + (detail.flagged ? ' · 星标' : ''))
  if (detail.attachments.length > 0) {
    lines.push(
      '附件（' +
        String(detail.attachments.length) +
        '）：' +
        detail.attachments
          .map(
            (attachment) =>
              String(attachment.index) +
              '. ' +
              attachment.filename +
              ' (' +
              attachment.contentType +
              ', ' +
              formatSize(attachment.size) +
              ')',
          )
          .join('；'),
    )
  }
  lines.push('')
  lines.push(truncate(detail.text, maxBodyChars))
  return lines.join('\n')
}

/** Standard status/summary rendering of the config view. */
function viewLines(view: ReturnType<MailStore['view']>): string[] {
  return [
    '账号：' + (view.email === '' ? '(未配置)' : view.email) + '（' + view.presetLabel + '）',
    '授权码：' + (view.authCodeSet ? '已配置 ' + view.authCodeHint : '未配置'),
    'IMAP：' + view.imap.host + ':' + String(view.imap.port) + (view.imap.secure ? ' (SSL)' : ' (STARTTLS)'),
    'SMTP：' + view.smtp.host + ':' + String(view.smtp.port) + (view.smtp.secure ? ' (SSL)' : ' (STARTTLS)'),
    '发件人显示名：' + (view.fromName === '' ? '(未设置)' : view.fromName),
    '签名：' + (view.signature === '' ? '(未设置)' : truncate(view.signature, 40)),
    '已发送文件夹：' + (view.sentFolder === '' ? '(自动探测)' : view.sentFolder),
    '发送后存副本：' + (view.saveSent ? '是' : '否'),
    '列表预览：' + (view.previewInList ? '开' : '关'),
    '附件目录：' + (view.downloadDir === '' ? '(默认)' : view.downloadDir),
    '模式：' + (view.readOnly ? '只读（写工具未注册）' : '读写（已开放发送/标记/移动/删除）') + '（来源：' + view.readOnlySource + '）',
    '超时：' + String(view.timeoutMs) + 'ms　解析上限：' + String(view.maxParseMb) + 'MB　发送上限：' + String(view.maxSendMb) + 'MB',
    '配置：' + view.configPath,
  ]
}

/* ------------------------------------------------------------------ */
/* Specs                                                                */
/* ------------------------------------------------------------------ */

/** Tool: plugin + account status, optionally probing the servers. */
export const qqmailStatusSpec: ToolSpec = {
  name: 'qqmail_status',
  description:
    '查看 dsh-qqmail 插件状态：邮箱是否已配置（地址、授权码是否已设置，不回显授权码）、IMAP/SMTP 服务器与端口、是否只读、配置路径；probe=true 时真实连接一次 IMAP/SMTP 验证凭据是否可用（会稍慢）。',
  parameters: {
    probe: { type: 'boolean', description: '是否真实连接 IMAP/SMTP 做一次自检（默认 false，只读配置）' },
  },
  write: false,
  handler: (args, ctx) =>
    guard(async () => {
      const view = ctx.store.view()
      const lines = viewLines(view)
      let data: Record<string, unknown> = { ...view, configPath: view.configPath }
      const probe = bool(args, 'probe', false)
      if (probe) {
        if (!ctx.service.isConfigured()) {
          lines.push('自检：跳过（配置不完整）')
        } else {
          const result = await ctx.service.probe()
          lines.push(
            '自检：IMAP ' +
              (result.imapOk ? '通过' : '失败') +
              (result.imapOk
                ? '（' + String(result.mailboxCount) + ' 个文件夹，已发送=' + (result.sentFolder === '' ? '未找到' : result.sentFolder) + '）'
                : '：' + result.imapError) +
              '；SMTP ' +
              (result.smtpOk ? '通过' : '失败' + (result.smtpError !== '' ? '：' + result.smtpError : '')),
          )
          data = { ...data, probe: result }
        }
      }
      return {
        ok: true,
        message: 'dsh-qqmail 状态：\n' + lines.join('\n'),
        data,
      }
    }),
}

/** Tool: read or change the plugin configuration. */
export const qqmailConfigSpec: ToolSpec = {
  name: 'qqmail_config',
  description:
    '配置 dsh-qqmail 邮箱连接。最常用：email（完整邮箱地址，如 someone@qq.com）+ authCode（QQ 邮箱的 16 位授权码，不是 QQ 密码）。preset 预设服务商（qq/qq-exmail/163/126/gmail/outlook/custom，默认按 email 域名自动识别）。其余可选：fromName（发件人显示名）、signature（签名）、sentFolder（已发送文件夹路径，默认自动探测）、downloadDir（附件默认目录）、readOnly（true=只注册读取类工具，false 才开放发送/标记/移动/删除）、timeoutMs、maxParseMb、maxSendMb、previewInList（列表是否带正文预览）、saveSent（发送后是否存副本）、imap*/smtp*（自定义服务器）。传 reset: true 恢复默认。配置存 DSH_HOME 下（默认 ~/.dsh/dsh-qqmail.json，0600，含授权码）。不带任何参数调用即返回当前配置（不回显授权码）。',
  parameters: {
    preset: { type: 'string', enum: [...PRESET_IDS], description: '服务商预设（默认按 email 域名自动识别）' },
    email: { type: 'string', description: '完整邮箱地址，如 someone@qq.com（同时作为 IMAP/SMTP 登录名）' },
    authCode: { type: 'string', description: '授权码（QQ 邮箱：设置→账号→开启 IMAP/SMTP 服务后生成的 16 位码）' },
    imapHost: { type: 'string', description: '自定义 IMAP 服务器（留空用预设）' },
    imapPort: { type: 'number', description: '自定义 IMAP 端口（留空用预设）' },
    imapSecure: { type: 'boolean', description: 'IMAP 是否 SSL（默认 true）' },
    smtpHost: { type: 'string', description: '自定义 SMTP 服务器（留空用预设）' },
    smtpPort: { type: 'number', description: '自定义 SMTP 端口（留空用预设）' },
    smtpSecure: { type: 'boolean', description: 'SMTP 是否 SSL（465=true；587=STARTTLS 传 false）' },
    smtpRequireTls: { type: 'boolean', description: '非 SSL 端口是否强制 STARTTLS 升级（默认 true；本地中继等纯明文服务器才关）' },
    fromName: { type: 'string', description: '发件人显示名' },
    signature: { type: 'string', description: '纯文本签名（自动附加到发信正文末尾）' },
    sentFolder: { type: 'string', description: '已发送文件夹路径（留空=自动探测）' },
    downloadDir: { type: 'string', description: '附件默认下载目录（留空=工作区）' },
    readOnly: { type: 'boolean', description: 'true=只读（写工具不注册）；false=开放发送/标记/移动/删除' },
    timeoutMs: { type: 'number', description: '连接与命令超时毫秒数（默认 30000）' },
    maxParseMb: { type: 'number', description: '单封邮件解析上限 MB（默认 40）' },
    maxSendMb: { type: 'number', description: '单封发送体积上限 MB（默认 40）' },
    previewInList: { type: 'boolean', description: '列表结果是否附带正文预览（默认 false）' },
    saveSent: { type: 'boolean', description: '发送后是否存一份到已发送（默认 true）' },
    reset: { type: 'boolean', description: '设为 true 清除全部配置（含授权码）' },
  },
  write: false,
  handler: (args, ctx) =>
    guard(async () => {
      const before = ctx.store.readOnlySync()
      const touched = Object.keys(args).length > 0
      if (!touched) {
        const view = ctx.store.view()
        return {
          ok: true,
          message: 'dsh-qqmail 当前配置（未改动）：\n' + viewLines(view).join('\n'),
          data: view,
        }
      }
      const patch: Parameters<MailStore['patch']>[0] = {}
      if (presetOf(args) !== undefined) patch.preset = presetOf(args)
      for (const key of [
        'email',
        'authCode',
        'imapHost',
        'smtpHost',
        'fromName',
        'signature',
        'sentFolder',
        'downloadDir',
      ] as const) {
        if (typeof args[key] === 'string') patch[key] = args[key] as string
      }
      for (const key of ['imapPort', 'smtpPort', 'timeoutMs', 'maxParseMb', 'maxSendMb'] as const) {
        if (typeof args[key] === 'number') patch[key] = args[key] as number
      }
      for (const key of ['imapSecure', 'smtpSecure', 'smtpRequireTls', 'readOnly', 'previewInList', 'saveSent'] as const) {
        if (typeof args[key] === 'boolean') patch[key] = args[key] as boolean
      }
      if (args.reset === true) patch.reset = true
      const view = await ctx.store.patch(patch)
      const after = ctx.store.readOnlySync()
      if (after.value !== before.value) ctx.onConfigChanged?.()
      // A credential change invalidates any pooled connection.
      if (patch.reset === true || patch.authCode !== undefined || patch.email !== undefined || patch.imapHost !== undefined) {
        await ctx.service.closeAll()
      }
      return {
        ok: true,
        message: '已更新 dsh-qqmail 配置：\n' + viewLines(view).join('\n'),
        data: view,
      }
    }),
}

/** Tool: list mailboxes. */
export const qqmailFoldersSpec: ToolSpec = {
  name: 'qqmail_folders',
  description:
    '列出邮箱里的所有文件夹（INBOX、已发送、草稿、已删除、垃圾邮件等），可选同时给出每个文件夹的邮件总数与未读数。先用它拿到准确的文件夹路径，再喂给 qqmail_list / qqmail_move 的 mailbox 参数。',
  parameters: {
    status: { type: 'boolean', description: '是否附带每个文件夹的邮件数/未读数（默认 true，会多几轮请求）' },
  },
  write: false,
  handler: (args, ctx) =>
    guard(async () => {
      const withStatus = bool(args, 'status', true)
      const mailboxes = await ctx.service.folders(withStatus)
      const special = mailboxes.filter((entry) => entry.specialUse !== '').length
      return {
        ok: true,
        message:
          '共 ' +
          String(mailboxes.length) +
          ' 个文件夹' +
          (special > 0 ? '（' + String(special) + ' 个带特殊用途标记）' : '') +
          '：\n' +
          mailboxes.map(mailboxLine).join('\n'),
        data: { mailboxes, count: mailboxes.length },
      }
    }),
}

/** Tool: list the newest messages in a mailbox. */
export const qqmailListSpec: ToolSpec = {
  name: 'qqmail_list',
  description:
    '列出某个文件夹里的邮件（默认收件箱 INBOX，最新在前）。返回每封邮件的 uid、时间、发件人、主题、未读/星标/附件标记，uid 可直接喂给 qqmail_read / qqmail_mark / qqmail_move / qqmail_delete。unseen=true 只看未读，flagged=true 只看星标。',
  parameters: {
    mailbox: { type: 'string', description: '文件夹路径（默认 INBOX；可用 qqmail_folders 查看）' },
    limit: { type: 'number', description: '返回条数（默认 20，最大 200）' },
    order: { type: 'string', enum: ['desc', 'asc'], description: '排序：desc=最新在前（默认），asc=最早在前' },
    unseen: { type: 'boolean', description: '只看未读邮件' },
    flagged: { type: 'boolean', description: '只看星标邮件' },
    preview: { type: 'boolean', description: '是否附带正文预览（默认跟随配置 previewInList，通常为否）' },
  },
  write: false,
  handler: (args, ctx) =>
    guard(async () => {
      const limit = int(args, 'limit', 20, 1, 200)
      const result = await ctx.service.listMessages({
        mailbox: str(args, 'mailbox', 'INBOX') || 'INBOX',
        limit,
        order: str(args, 'order', 'desc') === 'asc' ? 'asc' : 'desc',
        unseen: bool(args, 'unseen', false),
        flagged: bool(args, 'flagged', false),
        preview: optBool(args, 'preview'),
      })
      return {
        ok: true,
        message: renderList(result),
        data: {
          mailbox: result.mailbox,
          mode: result.mode,
          total: result.total,
          truncated: result.truncated,
          items: result.items,
        },
      }
    }),
}

/** Tool: full-text search. */
export const qqmailSearchSpec: ToolSpec = {
  name: 'qqmail_search',
  description:
    '搜索邮件：可按发件人 from、收件人 to、主题 subject、正文 body、全文 text、时间区间 since/before（YYYY-MM-DD 或 ISO）、未读 unseen、星标 flagged、体积 larger/smaller（字节）组合筛选。注意搜索方式：**中文关键词走本地窗口过滤**（服务器端 IMAP SEARCH 对非 ASCII 不可靠），只扫描最近约 400 封并在结果里标明 mode=local；英文/数字关键词走服务器端精确搜索，但**正文/全文**条件在服务器端零命中时会自动再用本地窗口复查一次（非 ASCII 正文会被 MIME 编码，服务器看不到其中的英文词）——因此 mode=local 代表「最近约 400 封之内」的结论。',
  parameters: {
    mailbox: { type: 'string', description: '文件夹路径（默认 INBOX）' },
    from: { type: 'string', description: '发件人包含该字符串' },
    to: { type: 'string', description: '收件人包含该字符串' },
    subject: { type: 'string', description: '主题包含该字符串' },
    body: { type: 'string', description: '正文包含该字符串' },
    text: { type: 'string', description: '全文（头+正文）包含该字符串' },
    since: { type: 'string', description: '此日期及之后（YYYY-MM-DD 或 ISO）' },
    before: { type: 'string', description: '此日期之前（YYYY-MM-DD 或 ISO）' },
    unseen: { type: 'boolean', description: '只看未读' },
    flagged: { type: 'boolean', description: '只看星标' },
    larger: { type: 'number', description: '大于该字节数' },
    smaller: { type: 'number', description: '小于该字节数' },
    limit: { type: 'number', description: '返回条数（默认 20，最大 200）' },
    order: { type: 'string', enum: ['desc', 'asc'], description: '排序（默认 desc=最新在前）' },
    preview: { type: 'boolean', description: '是否附带正文预览（默认 true，本地过滤模式下强制开启）' },
  },
  write: false,
  handler: (args, ctx) =>
    guard(async () => {
      const limit = int(args, 'limit', 20, 1, 200)
      const query = normalizeQuery({
        mailbox: str(args, 'mailbox', 'INBOX') || 'INBOX',
        from: str(args, 'from'),
        to: str(args, 'to'),
        subject: str(args, 'subject'),
        body: str(args, 'body'),
        text: str(args, 'text'),
        since: str(args, 'since'),
        before: str(args, 'before'),
        unseen: bool(args, 'unseen', false),
        flagged: bool(args, 'flagged', false),
        larger: int(args, 'larger', 0, 0, Number.MAX_SAFE_INTEGER),
        smaller: int(args, 'smaller', 0, 0, Number.MAX_SAFE_INTEGER),
      })
      const result = await ctx.service.searchMessages(query, {
        limit,
        order: str(args, 'order', 'desc') === 'asc' ? 'asc' : 'desc',
        preview: bool(args, 'preview', true),
      })
      return {
        ok: true,
        message: renderList(result),
        data: {
          mailbox: result.mailbox,
          mode: result.mode,
          total: result.total,
          truncated: result.truncated,
          query,
          items: result.items,
        },
      }
    }),
}

/** Tool: read one or more messages in full. */
export const qqmailReadSpec: ToolSpec = {
  name: 'qqmail_read',
  description:
    '读取一封或多封邮件的完整内容（正文纯文本 + 附件清单 + 头部）。传 uid（单个）或 uids（数组，最多 10 封）批量读取——批量读比逐封读快得多。uid 来自 qqmail_list / qqmail_search。默认不会把邮件标为已读（markSeen=false），需要时显式传 true。',
  parameters: {
    uid: { type: 'number', description: '单个邮件 uid' },
    uids: { type: 'array', items: { type: 'number' }, description: '多个邮件 uid（最多 10 个）' },
    mailbox: { type: 'string', description: '邮件所在文件夹（默认 INBOX）' },
    html: { type: 'boolean', description: '是否同时返回原始 HTML 正文（默认 false，省 token）' },
    markSeen: { type: 'boolean', description: '是否把读过的邮件标为已读（默认 false）' },
    maxBodyChars: { type: 'number', description: '每封正文最多返回字符数（默认 4000）' },
  },
  write: false,
  handler: (args, ctx) =>
    guard(async () => {
      const targets = uids(args).slice(0, 10)
      if (targets.length === 0) {
        return { ok: false, message: '请给出 uid（单个）或 uids（数组），例如 uid: 12345。' }
      }
      const mailbox = str(args, 'mailbox', 'INBOX') || 'INBOX'
      const maxBodyChars = int(args, 'maxBodyChars', 4000, 200, 100_000)
      const result = await ctx.service.readMessages(targets, {
        mailbox,
        html: bool(args, 'html', false),
        markSeen: bool(args, 'markSeen', false),
      })
      const parts = result.items.map((detail) => renderDetail(detail, maxBodyChars))
      if (result.errors.length > 0) parts.push('读取失败：\n' + result.errors.map((line) => '  ' + line).join('\n'))
      return {
        ok: result.items.length > 0,
        message: parts.length > 0 ? parts.join('\n\n────────\n\n') : result.errors.join('\n'),
        data: { mailbox, items: result.items, errors: result.errors },
      }
    }),
}

/** Tool: send a message. */
export const qqmailSendSpec: ToolSpec = {
  name: 'qqmail_send',
  description:
    '发送一封邮件。to 为收件人数组（必填），可选 cc/bcc。subject 主题（建议填写），text 纯文本正文（html 可选，两者都给时客户端可择优显示）。attachments 是本机文件的绝对路径数组（会读文件作为附件）。默认发送后自动存一份到「已发送」（可用 saveSent: false 关闭）。这是**真实发信**，请确认收件人与内容无误。',
  parameters: {
    to: { type: 'array', items: { type: 'string' }, required: true, description: '收件人数组（必填）' },
    cc: { type: 'array', items: { type: 'string' }, description: '抄送数组' },
    bcc: { type: 'array', items: { type: 'string' }, description: '密送数组' },
    subject: { type: 'string', description: '主题' },
    text: { type: 'string', description: '纯文本正文' },
    html: { type: 'string', description: 'HTML 正文（可选）' },
    attachments: { type: 'array', items: { type: 'string' }, description: '附件文件的绝对路径数组' },
    saveSent: { type: 'boolean', description: '是否存副本到已发送（默认跟随配置，通常 true）' },
  },
  write: true,
  handler: (args, ctx) =>
    guard(async () => {
      const to = list(args, 'to')
      if (to.length === 0) return { ok: false, message: '至少需要一个收件人（to）。' }
      const files = list(args, 'attachments')
      const outgoing: { filename: string; path: string }[] = []
      for (const file of files) {
        const resolved = path.resolve(file)
        const info = await stat(resolved).catch(() => null)
        if (info === null || !info.isFile()) {
          return { ok: false, message: '附件不存在或不是文件：' + resolved }
        }
        outgoing.push({ filename: safeFilename(path.basename(resolved)), path: resolved })
      }
      const view = ctx.store.view()
      const body = raw(args, 'text')
      const text = view.signature.trim() === '' ? body : appendSignature(body, view.signature)
      const result = await ctx.service.send({
        to,
        cc: list(args, 'cc'),
        bcc: list(args, 'bcc'),
        subject: str(args, 'subject'),
        text,
        html: raw(args, 'html'),
        attachments: outgoing,
        inReplyTo: '',
        references: [],
        saveSent: optBool(args, 'saveSent'),
      })
      const lines = [
        '已发送：' + (str(args, 'subject') === '' ? '(无主题)' : str(args, 'subject')),
        '收件人：' + to.join(', ') + (list(args, 'cc').length > 0 ? '　抄送：' + list(args, 'cc').join(', ') : ''),
        'SMTP 回应：' + (result.response === '' ? '(无)' : result.response),
        'Message-ID：' + (result.messageId === '' ? '(无)' : result.messageId),
      ]
      if (result.savedTo !== '') lines.push('已存副本到：' + result.savedTo)
      else if (result.saveError !== '') lines.push('⚠️ 邮件已发出，但存副本失败：' + result.saveError)
      return {
        ok: true,
        message: lines.join('\n'),
        data: result,
      }
    }),
}

/** Tool: reply to a message. */
export const qqmailReplySpec: ToolSpec = {
  name: 'qqmail_reply',
  description:
    '回复某封邮件（uid 来自 qqmail_list / qqmail_search）。自动使用原邮件的发件人作为收件人（replyAll=true 时带上原收件人，并自动排除自己），主题加 Re: 前缀，带上 In-Reply-To/References 让客户端正确串成会话，并在正文末尾附上引用原文。',
  parameters: {
    uid: { type: 'number', required: true, description: '要回复的邮件 uid（必填）' },
    text: { type: 'string', required: true, description: '回复正文（必填）' },
    mailbox: { type: 'string', description: '原邮件所在文件夹（默认 INBOX）' },
    replyAll: { type: 'boolean', description: '是否回复全部（默认 false，只回发件人）' },
    html: { type: 'string', description: 'HTML 正文（可选）' },
    attachments: { type: 'array', items: { type: 'string' }, description: '附件文件绝对路径数组' },
    quoteOriginal: { type: 'boolean', description: '是否在正文末尾引用原文（默认 true）' },
    saveSent: { type: 'boolean', description: '是否存副本到已发送（默认跟随配置）' },
  },
  write: true,
  handler: (args, ctx) =>
    guard(async () => {
      const target = uids(args)[0]
      if (target === undefined) return { ok: false, message: '请给出要回复的邮件 uid。' }
      const body = raw(args, 'text')
      if (body.trim() === '') return { ok: false, message: '回复正文不能为空（text）。' }
      const mailbox = str(args, 'mailbox', 'INBOX') || 'INBOX'
      const view = ctx.store.view()
      const original = (await ctx.service.readMessages([target], { mailbox, html: false, markSeen: false })).items[0]
      if (original === undefined) {
        return { ok: false, message: '读取原邮件失败：uid ' + String(target) + ' 在「' + mailbox + '」里不存在。' }
      }
      const self = view.email.toLowerCase()
      const replyAll = bool(args, 'replyAll', false)
      const candidates = replyAll
        ? [...original.replyTo, ...original.from, ...original.to]
        : original.replyTo.length > 0
          ? original.replyTo
          : original.from
      const recipients = [...new Set(candidates.map((entry) => entry.address.trim()).filter((entry) => entry !== ''))]
        .filter((entry) => entry.toLowerCase() !== self)
      if (recipients.length === 0) {
        return { ok: false, message: '没有可回复的收件人（原邮件发件人缺失或只有自己）。' }
      }
      const subject = /^re:/i.test(original.subject) ? original.subject : 'Re: ' + original.subject
      const quoted =
        bool(args, 'quoteOriginal', true) && original.text.trim() !== ''
          ? '\n\n────────\n在 ' +
            localDateTime(original.date === '' ? undefined : new Date(original.date)) +
            '，' +
            (original.from.map(formatAddress).join(', ') || '(未知发件人)') +
            ' 写道：\n' +
            original.text
              .split('\n')
              .map((line) => '> ' + line)
              .join('\n')
              .slice(0, 4000)
          : ''
      const text = appendSignature(body + quoted, view.signature)
      const files = list(args, 'attachments')
      const outgoing: { filename: string; path: string }[] = []
      for (const file of files) {
        const resolved = path.resolve(file)
        const info = await stat(resolved).catch(() => null)
        if (info === null || !info.isFile()) return { ok: false, message: '附件不存在或不是文件：' + resolved }
        outgoing.push({ filename: safeFilename(path.basename(resolved)), path: resolved })
      }
      const references = [...original.references, original.messageId].filter((entry) => entry !== '')
      const result = await ctx.service.send({
        to: recipients,
        cc: [],
        bcc: [],
        subject,
        text,
        html: raw(args, 'html'),
        attachments: outgoing,
        inReplyTo: original.messageId,
        references,
        saveSent: optBool(args, 'saveSent'),
      })
      const lines = [
        '已回复 uid ' + String(target) + '：' + subject,
        '收件人：' + recipients.join(', '),
        'SMTP 回应：' + (result.response === '' ? '(无)' : result.response),
      ]
      if (result.savedTo !== '') lines.push('已存副本到：' + result.savedTo)
      else if (result.saveError !== '') lines.push('⚠️ 回复已发出，但存副本失败：' + result.saveError)
      return { ok: true, message: lines.join('\n'), data: result }
    }),
}

/** Tool: set flags. */
export const qqmailMarkSpec: ToolSpec = {
  name: 'qqmail_mark',
  description:
    '给一封或多封邮件加/去标记：seen=true 标为已读、seen=false 标为未读，flagged=true 加星标、flagged=false 去星标。uid 用 uid（单个）或 uids（数组）。',
  parameters: {
    uid: { type: 'number', description: '单个邮件 uid' },
    uids: { type: 'array', items: { type: 'number' }, description: '多个邮件 uid' },
    mailbox: { type: 'string', description: '邮件所在文件夹（默认 INBOX）' },
    seen: { type: 'boolean', description: 'true=标为已读，false=标为未读' },
    flagged: { type: 'boolean', description: 'true=加星标，false=去星标' },
  },
  write: true,
  handler: (args, ctx) =>
    guard(async () => {
      const targets = uids(args)
      if (targets.length === 0) return { ok: false, message: '请给出 uid 或 uids。' }
      const mailbox = str(args, 'mailbox', 'INBOX') || 'INBOX'
      const outcome = await ctx.service.mark(targets, mailbox, {
        seen: optBool(args, 'seen'),
        flagged: optBool(args, 'flagged'),
      })
      return {
        ok: true,
        message:
          '已更新 ' +
          String(outcome.changed) +
          ' 封邮件的标记（' +
          outcome.applied.join('、') +
          '）' +
          '（文件夹：' +
          mailbox +
          '）',
        data: { ...outcome, mailbox, uids: targets },
      }
    }),
}

/** Tool: move messages. */
export const qqmailMoveSpec: ToolSpec = {
  name: 'qqmail_move',
  description:
    '把一封或多封邮件移动到另一个文件夹（如移到「已删除」或某个分类文件夹）。destination 必须是已存在的文件夹路径，可用 qqmail_folders 查看。uid 用 uid（单个）或 uids（数组）。',
  parameters: {
    uid: { type: 'number', description: '单个邮件 uid' },
    uids: { type: 'array', items: { type: 'number' }, description: '多个邮件 uid' },
    mailbox: { type: 'string', description: '邮件当前所在文件夹（默认 INBOX）' },
    destination: { type: 'string', required: true, description: '目标文件夹路径（必填）' },
  },
  write: true,
  handler: (args, ctx) =>
    guard(async () => {
      const targets = uids(args)
      if (targets.length === 0) return { ok: false, message: '请给出 uid 或 uids。' }
      const destination = str(args, 'destination')
      if (destination === '') return { ok: false, message: '请给出目标文件夹 destination。' }
      const mailbox = str(args, 'mailbox', 'INBOX') || 'INBOX'
      const outcome = await ctx.service.move(targets, mailbox, destination)
      return {
        ok: true,
        message:
          '已把 ' +
          String(outcome.moved) +
          ' 封邮件从「' +
          mailbox +
          '」移动到「' +
          destination +
          '」（uid：' +
          targets.join(', ') +
          '）',
        data: { ...outcome, mailbox, destination, uids: targets },
      }
    }),
}

/** Tool: delete messages. */
export const qqmailDeleteSpec: ToolSpec = {
  name: 'qqmail_delete',
  description:
    '删除一封或多封邮件。默认（permanent=false）是**移动到「已删除」文件夹**（可恢复）；permanent=true 才会在服务器上彻底删除（\\Deleted + EXPUNGE，不可恢复）。uid 用 uid（单个）或 uids（数组）。',
  parameters: {
    uid: { type: 'number', description: '单个邮件 uid' },
    uids: { type: 'array', items: { type: 'number' }, description: '多个邮件 uid' },
    mailbox: { type: 'string', description: '邮件所在文件夹（默认 INBOX）' },
    permanent: { type: 'boolean', description: 'true=彻底删除（不可恢复）；默认 false=移到已删除' },
  },
  write: true,
  handler: (args, ctx) =>
    guard(async () => {
      const targets = uids(args)
      if (targets.length === 0) return { ok: false, message: '请给出 uid 或 uids。' }
      const mailbox = str(args, 'mailbox', 'INBOX') || 'INBOX'
      const permanent = bool(args, 'permanent', false)
      const outcome = await ctx.service.remove(targets, mailbox, permanent)
      return {
        ok: true,
        message:
          (permanent ? '已在服务器上彻底删除 ' : '已把 ') +
          String(outcome.count) +
          ' 封邮件' +
          (permanent ? '' : '移动到「' + outcome.trashFolder + '」（可从已删除恢复）') +
          '（uid：' +
          targets.join(', ') +
          '）',
        data: { ...outcome, mailbox, uids: targets },
      }
    }),
}

/** Tool: download one attachment. */
export const qqmailAttachmentSpec: ToolSpec = {
  name: 'qqmail_attachment',
  description:
    '把某封邮件里的第 index 个附件下载到本地文件。index 从 1 开始，顺序与 qqmail_read 返回的附件清单一致。outDir 省略时写到插件配置的 downloadDir（未配置则工作区）。同名文件不会覆盖，会自动加 -1/-2 后缀。',
  parameters: {
    uid: { type: 'number', required: true, description: '邮件 uid（必填）' },
    index: { type: 'number', required: true, description: '附件序号，从 1 开始（必填）' },
    mailbox: { type: 'string', description: '邮件所在文件夹（默认 INBOX）' },
    outDir: { type: 'string', description: '保存目录（默认取配置 downloadDir，未配置则工作区）' },
  },
  write: false,
  handler: (args, ctx) =>
    guard(async () => {
      const uid = uids(args)[0]
      if (uid === undefined) return { ok: false, message: '请给出 uid。' }
      const index = int(args, 'index', 0, 1, 1000)
      if (index < 1) return { ok: false, message: '请给出 index（附件序号，从 1 开始）。' }
      const mailbox = str(args, 'mailbox', 'INBOX') || 'INBOX'
      const configured = ctx.store.view().downloadDir
      const outDir = str(args, 'outDir') !== '' ? path.resolve(str(args, 'outDir')) : configured !== '' ? path.resolve(configured) : ctx.workspaceDir
      const result = await ctx.service.downloadAttachment(uid, index, mailbox, outDir)
      return {
        ok: true,
        message:
          '已下载附件到：' +
          result.path +
          '（' +
          result.filename +
          '，' +
          result.contentType +
          '，' +
          formatSize(result.size) +
          '）',
        data: result,
      }
    }),
}

/** Every spec, in registration order. */
export function allSpecs(): ToolSpec[] {
  return [
    qqmailStatusSpec,
    qqmailConfigSpec,
    qqmailFoldersSpec,
    qqmailListSpec,
    qqmailSearchSpec,
    qqmailReadSpec,
    qqmailSendSpec,
    qqmailReplySpec,
    qqmailMarkSpec,
    qqmailMoveSpec,
    qqmailDeleteSpec,
    qqmailAttachmentSpec,
  ]
}

/** Build the roster for the current mode. */
export function buildSpecs(readOnly: boolean): ToolSpec[] {
  return allSpecs().filter((spec) => !readOnly || !spec.write)
}

/** Preset ids, re-exported for panels and tests. */
export { PRESETS, PRESET_IDS }

/** Signature append reused by send/reply. */
function appendSignature(body: string, signature: string): string {
  const text = body.replace(/\s+$/, '')
  const mark = signature.trim()
  if (mark === '') return text
  return text === '' ? mark : text + '\n\n' + mark
}
