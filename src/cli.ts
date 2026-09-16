/**
 * dsh-qqmail — command line entry (`qqmail`).
 *
 * A thin shell over the same {@link ToolSpec} handlers the agent tools use, so
 * a script (or another agent that cannot host the plugin) gets identical
 * behaviour and identical wording. Prints the spec's `message` by default and
 * the structured payload with `--json`.
 *
 * Credentials come from the same `<DSH_HOME>/dsh-qqmail.json` the plugin writes,
 * so configuring the mailbox once in the DSH settings panel is enough.
 */

import process from 'node:process'

import { MailService, normalizeQuery } from './mail.ts'
import { MailStore, dataDir } from './store.ts'
import { allSpecs, type SpecContext, type SpecResult, type ToolSpec } from './specs.ts'

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set([
  'probe',
  'status',
  'unseen',
  'flagged',
  'html',
  'mark-seen',
  'permanent',
  'read-only',
  'reset',
  'json',
  'help',
  'seen',
  'unseen-flag',
  'flag',
  'unflag',
  'reply-all',
  'no-quote',
  'no-save-sent',
  'preview',
])

/** Flags that may repeat and accumulate into an array. */
const REPEATABLE_FLAGS = new Set(['attach', 'attachments'])

/** Parsed command line. */
interface Parsed {
  command: string
  positional: string[]
  flags: Record<string, string | boolean | string[]>
}

/** Parse `argv` (already stripped of node and the script path). */
export function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = []
  const flags: Record<string, string | boolean | string[]> = {}
  let index = 0
  while (index < argv.length) {
    const token = argv[index] as string
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const equals = body.indexOf('=')
      const key = equals >= 0 ? body.slice(0, equals) : body
      let value: string | boolean
      if (equals >= 0) {
        value = body.slice(equals + 1)
      } else if (BOOLEAN_FLAGS.has(key)) {
        value = true
      } else {
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) {
          value = true
        } else {
          value = next
          index += 1
        }
      }
      if (REPEATABLE_FLAGS.has(key)) {
        const existing = flags[key]
        const entry = typeof value === 'string' ? value : String(value)
        if (Array.isArray(existing)) existing.push(entry)
        else flags[key] = [entry]
      } else {
        flags[key] = value
      }
      index += 1
      continue
    }
    positional.push(token)
    index += 1
  }
  return {
    command: positional.length > 0 ? (positional[0] as string) : 'help',
    positional: positional.slice(1),
    flags,
  }
}

/** kebab-case → camelCase (CLI flag → spec argument). */
function camel(key: string): string {
  return key.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}

/** Read a string flag. */
function flagString(parsed: Parsed, key: string): string {
  const value = parsed.flags[key]
  return typeof value === 'string' ? value : ''
}

/** Read a boolean flag. */
function flagBool(parsed: Parsed, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === 'true'
}

/** Read an accumulating flag. */
function flagList(parsed: Parsed, key: string): string[] {
  const value = parsed.flags[key]
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')
  return []
}

/**
 * Resolve the authorization code for `qqmail config`.
 *
 * Three sources, best first: the `QQMAIL_AUTH_CODE` environment variable (never
 * lands in the process list), `--auth-code -` reading stdin, then the flag
 * itself — which is accepted but warned about, because `ps` shows it.
 */
async function resolveAuthCode(parsed: Parsed): Promise<string> {
  const fromEnv = (process.env.QQMAIL_AUTH_CODE ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const value = flagString(parsed, 'auth-code')
  if (value === '-') {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').trim()
  }
  if (value !== '') {
    process.stderr.write('⚠️  --auth-code 会出现在进程列表里；建议改用环境变量 QQMAIL_AUTH_CODE 或 --auth-code -\n')
  }
  return value
}

/** Build the spec arguments for one CLI command. */
async function buildArgs(parsed: Parsed, specName: string): Promise<Record<string, unknown> | string> {
  const numeric = (value: string, fallback: number): number => {
    const num = Number(value)
    return Number.isFinite(num) ? num : fallback
  }
  switch (specName) {
    case 'qqmail_status':
      return { probe: flagBool(parsed, 'probe') }
    case 'qqmail_config': {
      const args: Record<string, unknown> = {}
      for (const key of [
        'preset',
        'email',
        'imap-host',
        'imap-port',
        'imap-secure',
        'smtp-host',
        'smtp-port',
        'smtp-secure',
        'from-name',
        'signature',
        'sent-folder',
        'download-dir',
        'timeout-ms',
        'max-parse-mb',
        'max-send-mb',
      ]) {
        if (parsed.flags[key] !== undefined) args[camel(key)] = parsed.flags[key]
      }
      if (parsed.flags['read-only'] !== undefined) args.readOnly = flagBool(parsed, 'read-only')
      if (parsed.flags['preview'] !== undefined) args.previewInList = flagBool(parsed, 'preview')
      if (parsed.flags['reset'] === true) args.reset = true
      const authCode = await resolveAuthCode(parsed)
      if (authCode !== '') args.authCode = authCode
      // Allow `--set key=value` passthrough for anything not listed above.
      const extras = flagList(parsed, 'set')
      for (const extra of extras) {
        const [key, ...rest] = extra.split('=')
        if (key !== undefined && key !== '') args[camel(key)] = rest.join('=')
      }
      return args
    }
    case 'qqmail_folders':
      return { status: parsed.flags['status'] !== 'false' }
    case 'qqmail_list':
      return {
        mailbox: flagString(parsed, 'mailbox') || 'INBOX',
        limit: numeric(flagString(parsed, 'limit'), 20),
        order: flagString(parsed, 'order') || 'desc',
        unseen: flagBool(parsed, 'unseen'),
        flagged: flagBool(parsed, 'flagged'),
        ...(parsed.flags['preview'] !== undefined ? { preview: flagBool(parsed, 'preview') } : {}),
      }
    case 'qqmail_search': {
      const keyword = parsed.positional.join(' ').trim()
      const query = normalizeQuery({
        mailbox: flagString(parsed, 'mailbox') || 'INBOX',
        from: flagString(parsed, 'from'),
        to: flagString(parsed, 'to'),
        subject: flagString(parsed, 'subject'),
        body: flagString(parsed, 'body'),
        text: flagString(parsed, 'text') !== '' ? flagString(parsed, 'text') : keyword,
        since: flagString(parsed, 'since'),
        before: flagString(parsed, 'before'),
        unseen: flagBool(parsed, 'unseen'),
        flagged: flagBool(parsed, 'flagged'),
        larger: numeric(flagString(parsed, 'larger'), 0),
        smaller: numeric(flagString(parsed, 'smaller'), 0),
      })
      return {
        ...query,
        limit: numeric(flagString(parsed, 'limit'), 20),
        order: flagString(parsed, 'order') || 'desc',
      }
    }
    case 'qqmail_read': {
      const ids = parsed.positional.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
      if (ids.length === 0) return '用法：qqmail read <uid> [uid...] [--mailbox INBOX] [--html] [--mark-seen]'
      return {
        uids: ids,
        mailbox: flagString(parsed, 'mailbox') || 'INBOX',
        html: flagBool(parsed, 'html'),
        markSeen: flagBool(parsed, 'mark-seen'),
        maxBodyChars: numeric(flagString(parsed, 'max-chars'), 4000),
      }
    }
    case 'qqmail_send': {
      const to = flagList(parsed, 'to')
      if (to.length === 0) return '用法：qqmail send --to a@b.com [--cc ...] [--subject S] [--text B] [--attach 文件]'
      return {
        to,
        cc: flagList(parsed, 'cc'),
        bcc: flagList(parsed, 'bcc'),
        subject: flagString(parsed, 'subject'),
        text: flagString(parsed, 'text'),
        html: flagString(parsed, 'html'),
        attachments: [...flagList(parsed, 'attach'), ...flagList(parsed, 'attachments')],
        ...(flagBool(parsed, 'no-save-sent') ? { saveSent: false } : {}),
      }
    }
    case 'qqmail_reply': {
      const uid = Number(parsed.positional[0] ?? '')
      const text = flagString(parsed, 'text')
      if (!Number.isFinite(uid)) return '用法：qqmail reply <uid> --text "回复内容" [--reply-all]'
      if (text === '') return '回复正文不能为空：请传 --text "..."'
      return {
        uid,
        text,
        mailbox: flagString(parsed, 'mailbox') || 'INBOX',
        replyAll: flagBool(parsed, 'reply-all'),
        quoteOriginal: !flagBool(parsed, 'no-quote'),
        attachments: [...flagList(parsed, 'attach'), ...flagList(parsed, 'attachments')],
        ...(flagBool(parsed, 'no-save-sent') ? { saveSent: false } : {}),
      }
    }
    case 'qqmail_mark': {
      const ids = parsed.positional.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
      if (ids.length === 0) return '用法：qqmail mark <uid> [uid...] [--seen|--unseen] [--flag|--unflag]'
      const args: Record<string, unknown> = { uids: ids, mailbox: flagString(parsed, 'mailbox') || 'INBOX' }
      if (parsed.flags['seen'] !== undefined) args.seen = true
      if (parsed.flags['unseen'] !== undefined) args.seen = false
      if (parsed.flags['flag'] !== undefined) args.flagged = true
      if (parsed.flags['unflag'] !== undefined) args.flagged = false
      return args
    }
    case 'qqmail_move': {
      const ids = parsed.positional.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
      const destination = flagString(parsed, 'to')
      if (ids.length === 0 || destination === '') return '用法：qqmail move <uid> [uid...] --to "目标文件夹"'
      return { uids: ids, mailbox: flagString(parsed, 'mailbox') || 'INBOX', destination }
    }
    case 'qqmail_delete': {
      const ids = parsed.positional.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry))
      if (ids.length === 0) return '用法：qqmail delete <uid> [uid...] [--permanent]'
      return {
        uids: ids,
        mailbox: flagString(parsed, 'mailbox') || 'INBOX',
        permanent: flagBool(parsed, 'permanent'),
      }
    }
    case 'qqmail_attachment': {
      const uid = Number(parsed.positional[0] ?? '')
      const index = Number(parsed.positional[1] ?? '')
      if (!Number.isFinite(uid) || !Number.isFinite(index)) return '用法：qqmail attachment <uid> <序号> [--out 目录]'
      return {
        uid,
        index,
        mailbox: flagString(parsed, 'mailbox') || 'INBOX',
        ...(flagString(parsed, 'out') !== '' ? { outDir: flagString(parsed, 'out') } : {}),
      }
    }
    default:
      return '未知命令。'
  }
}

/** Commands in the CLI, mapped to their spec. */
const COMMANDS: Record<string, string> = {
  status: 'qqmail_status',
  config: 'qqmail_config',
  folders: 'qqmail_folders',
  list: 'qqmail_list',
  search: 'qqmail_search',
  read: 'qqmail_read',
  send: 'qqmail_send',
  reply: 'qqmail_reply',
  mark: 'qqmail_mark',
  move: 'qqmail_move',
  delete: 'qqmail_delete',
  rm: 'qqmail_delete',
  attachment: 'qqmail_attachment',
  attach: 'qqmail_attachment',
}

/** Usage text. */
export const USAGE = `qqmail — QQ 邮箱 / 通用 IMAP·SMTP 邮箱的命令行入口（与 DSH 插件共用同一套实现与配置）

用法：qqmail <命令> [参数]

读取类：
  qqmail status [--probe]                     查看配置（--probe 真实连接自检）
  qqmail folders [--status]                   列出文件夹
  qqmail list [--mailbox INBOX] [--limit 20] [--unseen] [--flagged] [--preview]
  qqmail search [关键词] [--from X] [--subject X] [--body X] [--since 2026-01-01]
                        [--before 2026-02-01] [--unseen] [--flagged] [--limit 20]
  qqmail read <uid> [uid...] [--mailbox INBOX] [--html] [--mark-seen]
  qqmail attachment <uid> <序号> [--out 目录]

写入类（需要 readOnly=false）：
  qqmail send --to a@b.com [--cc X] [--bcc X] [--subject S] [--text B] [--attach 文件]
  qqmail reply <uid> --text "内容" [--reply-all] [--no-quote]
  qqmail mark <uid> [uid...] [--seen|--unseen] [--flag|--unflag]
  qqmail move <uid> [uid...] --to "目标文件夹"
  qqmail delete <uid> [uid...] [--permanent]
  qqmail config [--email someone@qq.com] [--auth-code -] [--read-only false] [...]

其他：
  qqmail mcp                                  以 MCP stdio 服务器启动（供其他 agent 接入）
  qqmail help                                 显示本帮助

配置：qqmail config --email someone@qq.com（授权码建议走环境变量 QQMAIL_AUTH_CODE）
  配置文件：DSH_HOME 下的 dsh-qqmail.json（默认 ~/.dsh/dsh-qqmail.json，0600）
  所有命令都支持 --json 输出结构化结果。
`

/** Entry point. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv)
  if (parsed.command === 'help' || parsed.command === '--help' || flagBool(parsed, 'help')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (parsed.command === 'version' || parsed.command === '--version') {
    process.stdout.write('dsh-qqmail 0.1.0\n')
    return 0
  }
  if (parsed.command === 'mcp') {
    const { runMcpServer } = await import('./mcp-server.ts')
    await runMcpServer()
    return 0
  }
  const specName = COMMANDS[parsed.command]
  if (specName === undefined) {
    process.stderr.write('未知命令「' + parsed.command + '」。\n\n' + USAGE)
    return 2
  }
  const store = new MailStore(true)
  const service = new MailService(store, 1_000)
  const spec = allSpecs().find((entry) => entry.name === specName)
  if (spec === undefined) {
    process.stderr.write('内部错误：找不到工具 ' + specName + '\n')
    return 2
  }
  const args = await buildArgs(parsed, specName)
  if (typeof args === 'string') {
    process.stderr.write(args + '\n')
    await service.closeAll()
    return 2
  }
  const context: SpecContext = {
    service,
    store,
    workspaceDir: process.cwd(),
  }
  let result: SpecResult
  try {
    result = await spec.handler(args, context)
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    await service.closeAll()
  }
  if (flagBool(parsed, 'json')) {
    process.stdout.write(
      JSON.stringify({ ok: result.ok, message: result.message, data: result.data ?? null }, null, 2) + '\n',
    )
  } else {
    process.stdout.write(result.message + '\n')
  }
  return result.ok ? 0 : 1
}

/** Helpers re-exported for the CLI tests. */
export { MailStore, dataDir, MailService, allSpecs }

// Only self-execute when run as the entry point (not when imported by a test).
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? ''
  return /(^|[/\\])cli\.(js|ts|mjs)$/.test(entry)
})()

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write('qqmail 执行失败：' + (error instanceof Error ? error.message : String(error)) + '\n')
      process.exitCode = 1
    })
}
