/**
 * dsh-qqmail — QQ Mail (and any IMAP/SMTP mailbox) for DeepSeek Harness. Host half.
 *
 * Registers the `qqmail_*` agent tools, the loopback `/api/dsh-qqmail/*` routes
 * behind the web panel, and the system-prompt announcement. The read-only
 * roster (status / config / folders / list / search / read / attachment) is
 * always mounted; send / reply / mark / move / delete only appear once the
 * effective `readOnly` switch is off, so nothing can mail or delete by accident.
 *
 * Credentials live in `<DSH_HOME>/dsh-qqmail.json` (mode 0600): the mailbox
 * address plus the provider **authorization code** — for QQ Mail a 16-character
 * code generated after enabling IMAP/SMTP, never the account password, and
 * never an OAuth dance.
 */

import path from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'

import { MailService } from './mail.ts'
import { makeRoutes } from './routes.ts'
import { MailStore, dataDir } from './store.ts'
import { buildTools, type SpecContext } from './tools.ts'

/** Stable cordis plugin name. */
export const name = 'qqmail'

/** Services required before the plugin surfaces can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 216

/** Where downloaded attachments land when no downloadDir is configured. */
export function attachmentsDir(): string {
  return path.join(dataDir(), 'attachments')
}

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const QQMAIL_GUIDANCE =
  '本机已安装 dsh-qqmail 插件（QQ 邮箱 / 通用 IMAP·SMTP 邮箱连接）：把邮箱收发能力做成 qqmail_* 工具——' +
  'qqmail_accounts（账号管理，新增/删除/设默认）、qqmail_status（配置与连接自检，probe=true 会真实连一次）、qqmail_config（配置邮箱，见下）、' +
  'qqmail_folders（列文件夹）、qqmail_list（列邮件，默认收件箱最新在前）、qqmail_search（按发件人/主题/正文/日期/未读/星标搜索）、' +
  'qqmail_read（读邮件全文，支持 uids 批量一次读多封）、qqmail_attachment（下载附件）。' +
  '写工具（仅当 readOnly=false 时注册）：qqmail_send（发信）、qqmail_reply（回复，自动带 Re:/In-Reply-To/引用原文）、' +
  'qqmail_mark（已读/未读/星标）、qqmail_move（移动文件夹）、qqmail_delete（默认移到「已删除」可恢复，permanent=true 才彻底删除）。' +
  '重要事实：① **必须用授权码而不是邮箱密码**——QQ 邮箱在网页版「设置 → 账号 → IMAP/SMTP服务」开启服务后生成 16 位授权码，' +
  '用 qqmail_config 传 email + authCode（首次使用应先 qqmail_status 看是否已配置）；' +
  '② 默认 readOnly=true，只注册读取类工具，需要发信时先 qqmail_config 设 readOnly=false；' +
  '③ 中文关键词搜索（主题/正文）走**本地窗口过滤**（只扫最近约 400 封，结果标 mode=local），英文/数字走服务器端精确搜索；' +
  '④ account 可传账号 id 或邮箱，省略用默认；新增用 qqmail_config account:__new__。uid 只在账号+文件夹内有效，跨账号需同时带 account 和 mailbox；' +
  '⑤ 附件默认下载到 DSH_HOME 下的 dsh-qqmail/attachments（可用 qqmail_config 的 downloadDir 改）。' +
  '用户提到「QQ 邮箱 / 邮箱 / 邮件 / 收发邮件 / agent email / 附件」时即指本插件，请据此协作。'

/** Plugin config, read from the composition row. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (tools, routes, prompt section). */
  enabled?: boolean
  /**
   * Seed for the read-only switch. The real switch lives in
   * <DSH_HOME>/dsh-qqmail.json; this value applies only until the store has an
   * explicit opinion (mirrors dsh-zhihu / dsh-xianyu).
   */
  readOnly?: boolean
}

/**
 * Mount the mail tools, routes and announcement.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  const announceToAgent = config?.announceToAgent !== false
  const enabled = config?.enabled !== false
  const store = new MailStore(config?.readOnly !== false)
  const service = new MailService(store)

  let disposeTools: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined

  const sync = (): void => {
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (!enabled) return
    // The roster depends on readOnly, which is a synchronous file read, so the
    // whole rebuild can stay inside one synchronous pass.
    const readOnly = store.readOnlySync().value
    const specContext: SpecContext = {
      service,
      store,
      workspaceDir: attachmentsDir(),
      onConfigChanged: () => {
        // Rebuild after the in-flight tool call settles, so the registry is not
        // mutated while it is still dispatching.
        setTimeout(sync, 0)
      },
    }
    disposeTools = ctx.effect(
      () => {
        const disposers = buildTools(specContext, readOnly).map((tool) => ctx.tools.register(tool))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-qqmail: tools',
    )
    disposeRoutes = ctx.effect(
      () => {
        const disposers = makeRoutes({
          store,
          service,
          workspaceDir: attachmentsDir(),
          onConfigChanged: () => {
            setTimeout(sync, 0)
          },
        }).map((route) => ctx.webServer.register(route))
        return () => {
          for (const dispose of disposers) dispose()
        }
      },
      'dsh-qqmail: routes',
    )
    if (announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-qqmail',
        order: SECTION_ORDER,
        text: QQMAIL_GUIDANCE,
      })
    }
  }

  sync()

  // Close pooled IMAP sockets when the plugin unloads, so a host restart does
  // not leave the provider holding connections open.
  ctx.effect(
    () => () => {
      void service.dispose()
    },
    'dsh-qqmail: session cleanup',
  )
}

/** Re-exports for host consumers, the CLI and the tests. */
export { dshHome } from './home.ts'
export {
  DEFAULT_CONFIG_FILE,
  DEFAULT_DATA_DIR,
  DEFAULT_MAX_PARSE_MB,
  DEFAULT_MAX_SEND_MB,
  DEFAULT_TIMEOUT_MS,
  MailStore,
  MAX_ACCOUNTS,
  resolveAccountRef,
  configExists,
  configPath,
  dataDir,
  maskSecret,
  type AccountConfig,
  type AccountResolution,
  type ConfigPatch,
  type MailConfig,
  type MailConfigView,
} from './store.ts'
export { MailService, LOCAL_SEARCH_WINDOW, matchesLocally, normalizeQuery, type SearchOptions } from './mail.ts'
export { PRESETS, PRESET_IDS, detectPreset, type Preset } from './core/presets.ts'
export {
  DEFAULT_IDLE_MS,
  ImapSession,
  buildSearchCriteria,
  describeImapError,
  hasAttachmentPart,
  listMailboxes,
  pickSpecialFolder,
  type ImapEndpoint,
  type SpecialFolderKind,
} from './core/imap.ts'
export {
  composeMessage,
  describeSmtpError,
  makeTransport,
  sendComposed,
  verifySmtp,
  type SmtpEndpoint,
} from './core/smtp.ts'
export {
  decodePreviewPart,
  decodeQuotedPrintable,
  parseSource,
  toAttachmentMeta,
  toDetail,
  toReferences,
} from './core/parse.ts'
export {
  appendSignature,
  formatAddress,
  formatAddressList,
  formatSize,
  hasNonAscii,
  isoDate,
  localDateTime,
  parseDate,
  safeFilename,
  senderLabel,
  singleLine,
  splitAddresses,
  stripHtml,
  toAddressList,
  truncate,
} from './core/mime.ts'
export { toJsonSchema, type JsonSchemaObject, type ParamSpec } from './core/schema.ts'
export { QQMAIL_API, makeRoutes, type RouteContext } from './routes.ts'
export { WRITE_TOOL_NAMES, buildSpecs, qqmailAccountsSpec, qqmailConfigSpec, qqmailStatusSpec, type SpecContext, type SpecResult, type ToolSpec } from './specs.ts'
export { buildTools, jsonSafe } from './tools.ts'
export type {
  Account,
  AttachmentMeta,
  MailboxInfo,
  MessageAddress,
  MessageDetail,
  MessageSummary,
  OutgoingMessage,
  PresetId,
  ProbeResult,
  SearchQuery,
  SearchResult,
  SendResult,
  ServerSettings,
} from './core/types.ts'
