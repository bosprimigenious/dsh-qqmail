/**
 * dsh-qqmail — configuration store.
 *
 * Owns `<DSH_HOME>/dsh-qqmail.json` (mode 0600 — it holds the mailbox
 * authorization code) and every path the plugin derives from it. The harness
 * home is `DSH_HOME` when set (some machines relocate it), falling back to
 * ~/.dsh.
 *
 * The stored secret is the *mailbox* authorization code, not the account
 * password: it can be revoked from the provider's web console without touching
 * the account itself. Nothing in this module ever returns it to a caller except
 * {@link MailStore.account}, which only the mail core uses.
 */

import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { pluginPath } from './home.ts'
import { PRESETS, detectPreset } from './core/presets.ts'
import type { Account, PresetId, ServerSettings } from './core/types.ts'

/** Re-exported for host consumers (the shared home resolver lives in home.ts). */
export { dshHome } from './home.ts'

/** Machine-wide config location (mode 0600). */
export const DEFAULT_CONFIG_FILE = pluginPath(undefined, 'dsh-qqmail.json')

/** Plugin scratch directory (probe cache, connection log). */
export const DEFAULT_DATA_DIR = pluginPath(undefined, 'dsh-qqmail')

/** Default connect/command timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Default cap on the raw source the plugin will parse (MB). */
export const DEFAULT_MAX_PARSE_MB = 40

/** Default cap on one outgoing message (MB). */
export const DEFAULT_MAX_SEND_MB = 40

/** Config location: DSH_QQMAIL_CONFIG → DSH_HOME → ~/.dsh (mode 0600). */
export function configPath(): string {
  return pluginPath(process.env.DSH_QQMAIL_CONFIG, 'dsh-qqmail.json')
}

/** Scratch dir: DSH_QQMAIL_DATA_DIR → DSH_HOME → ~/.dsh. */
export function dataDir(): string {
  return pluginPath(process.env.DSH_QQMAIL_DATA_DIR, 'dsh-qqmail')
}

/** Persisted configuration. Empty strings mean "use the preset default". */
export interface AccountConfig {
  id: string
  label: string
  preset: PresetId
  /** Full mailbox address — also the SMTP/IMAP login. */
  email: string
  /** Provider authorization code (the secret). */
  authCode: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  /** Require STARTTLS on a non-secure SMTP port (default true). */
  smtpRequireTls: boolean
  /** Display name on outgoing mail ('' = bare address). */
  fromName: string
  /** Plain-text signature appended to outgoing bodies ('' = none). */
  signature: string
  /** Sent-folder path ('' = auto-detect from the server's mailbox list). */
  sentFolder: string
  /** Default directory for downloaded attachments ('' = workspace default). */
  downloadDir: string
  timeoutMs: number
  maxParseMb: number
  maxSendMb: number
  /** Include a body preview in list results (adds one part fetch per message). */
  previewInList: boolean
  /** Save a copy of outgoing mail into the Sent folder. */
  saveSent: boolean
}

/** Versioned disk schema. Account settings never live at plugin scope. */
export interface MailConfig {
  version: 2
  defaultAccount: string
  readOnly: boolean | undefined
  accounts: AccountConfig[]
}

export const MAX_ACCOUNTS = 10

/** Public, secret-free configuration view. */
export interface MailConfigView {
  configured: boolean
  preset: PresetId
  presetLabel: string
  email: string
  /** Whether an authorization code is stored (never the value). */
  authCodeSet: boolean
  /** Masked hint, e.g. `abcd…(16 位)`, for the settings panel. */
  authCodeHint: string
  /** How to obtain the credential for this provider. */
  credentialHint: string
  imap: ServerSettings
  smtp: ServerSettings
  smtpRequireTls: boolean
  fromName: string
  signature: string
  sentFolder: string
  downloadDir: string
  readOnly: boolean
  readOnlySource: 'store' | 'row' | 'default'
  timeoutMs: number
  maxParseMb: number
  maxSendMb: number
  previewInList: boolean
  saveSent: boolean
  configPath: string
}

/** Configuration patch accepted from the tools / routes layer. */
export interface ConfigPatch {
  account?: string
  id?: string
  label?: string
  defaultAccount?: string
  remove?: boolean
  confirm?: boolean
  preset?: PresetId
  email?: string
  authCode?: string
  imapHost?: string
  imapPort?: number
  imapSecure?: boolean
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  smtpRequireTls?: boolean
  fromName?: string
  signature?: string
  sentFolder?: string
  downloadDir?: string
  readOnly?: boolean
  timeoutMs?: number
  maxParseMb?: number
  maxSendMb?: number
  previewInList?: boolean
  saveSent?: boolean
  reset?: boolean
}

/** Empty configuration record. */
function emptyAccount(id = ''): AccountConfig {
  return {
    id,
    label: '',
    preset: 'qq',
    email: '',
    authCode: '',
    imapHost: '',
    imapPort: 0,
    imapSecure: true,
    smtpHost: '',
    smtpPort: 0,
    smtpSecure: true,
    smtpRequireTls: true,
    fromName: '',
    signature: '',
    sentFolder: '',
    downloadDir: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxParseMb: DEFAULT_MAX_PARSE_MB,
    maxSendMb: DEFAULT_MAX_SEND_MB,
    previewInList: false,
    saveSent: true,
  }
}

/** True for a value that is a usable preset id. */
function isPreset(value: unknown): value is PresetId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, value)
}

/** Coerce unknown JSON into a MailConfig, ignoring malformed fields. */
function coerceAccount(raw: unknown, id: string): AccountConfig {
  const base = emptyAccount(id)
  if (typeof raw !== 'object' || raw === null) return base
  const obj = raw as Record<string, unknown>
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
      ? Math.floor(value)
      : fallback
  const str = (value: unknown, fallback: string): string =>
    typeof value === 'string' ? value : fallback
  const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback
  return {
    id,
    label: str(obj.label, ''),
    preset: isPreset(obj.preset) ? obj.preset : base.preset,
    email: str(obj.email, base.email),
    authCode: str(obj.authCode, base.authCode),
    imapHost: str(obj.imapHost, base.imapHost),
    imapPort: num(obj.imapPort, base.imapPort, 0, 65535),
    imapSecure: bool(obj.imapSecure, base.imapSecure),
    smtpHost: str(obj.smtpHost, base.smtpHost),
    smtpPort: num(obj.smtpPort, base.smtpPort, 0, 65535),
    smtpSecure: bool(obj.smtpSecure, base.smtpSecure),
    smtpRequireTls: bool(obj.smtpRequireTls, base.smtpRequireTls),
    fromName: str(obj.fromName, base.fromName),
    signature: str(obj.signature, base.signature),
    sentFolder: str(obj.sentFolder, base.sentFolder),
    downloadDir: str(obj.downloadDir, base.downloadDir),
    timeoutMs: num(obj.timeoutMs, base.timeoutMs, 1_000, 600_000),
    maxParseMb: num(obj.maxParseMb, base.maxParseMb, 1, 500),
    maxSendMb: num(obj.maxSendMb, base.maxSendMb, 1, 500),
    previewInList: bool(obj.previewInList, base.previewInList),
    saveSent: bool(obj.saveSent, base.saveSent),
  }
}

function empty(): MailConfig {
  return { version: 2, defaultAccount: '', readOnly: undefined, accounts: [] }
}

function validId(id: string): boolean {
  return /^[a-z0-9._-]{1,64}$/.test(id) && !['__new__', '.', '..'].includes(id)
}

function deriveId(email: string, used: Set<string>): string {
  const candidate = email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 64) || 'account'
  const stem = ['__new__', '.', '..'].includes(candidate) ? 'account' : candidate
  let id = stem
  for (let n = 2; used.has(id); n += 1) {
    const suffix = '-' + String(n)
    id = stem.slice(0, 64 - suffix.length) + suffix
  }
  return id
}

/** Bad data is readable as defaults, but must never be overwritten by patch. */
function coerce(raw: unknown): MailConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('配置不是 JSON 对象。')
  const obj = raw as Record<string, unknown>
  if (obj.version !== undefined && obj.version !== 1 && obj.version !== 2) throw new Error('不支持的配置版本。')
  const v2 = obj.version === 2
  if (v2 && !Array.isArray(obj.accounts)) throw new Error('v2 配置缺少 accounts 数组。')
  if (!v2 && obj.accounts !== undefined) throw new Error('accounts 配置需要 version: 2。')
  const entries = v2 ? obj.accounts as unknown[] : [obj]
  if (entries.length > MAX_ACCOUNTS) throw new Error('账号数量超过上限 10。')
  const ids = new Set<string>()
  const emails = new Set<string>()
  const accounts = entries.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error('账号配置不是对象。')
    const row = entry as Record<string, unknown>
    const email = typeof row.email === 'string' ? row.email : ''
    const id = v2 && row.id !== undefined ? row.id : deriveId(email, ids)
    if (typeof id !== 'string' || !validId(id) || ids.has(id)) throw new Error('账号 id 非法或重复。')
    const emailKey = email.trim().toLowerCase()
    if (emailKey !== '' && emails.has(emailKey)) throw new Error('邮箱地址重复。')
    ids.add(id)
    if (emailKey !== '') emails.add(emailKey)
    return coerceAccount(row, id)
  })
  return {
    version: 2,
    defaultAccount: v2 && typeof obj.defaultAccount === 'string' ? obj.defaultAccount : accounts[0]?.id ?? '',
    readOnly: typeof obj.readOnly === 'boolean' ? obj.readOnly : undefined,
    accounts,
  }
}

export interface AccountResolution {
  config: AccountConfig | undefined
  error: string
  warning: string
}

/** Only an omitted ref can fall back; an explicit unknown ref fails closed. */
export function resolveAccountRef(config: MailConfig, ref?: string): AccountResolution {
  if (ref !== undefined) {
    const selected = config.accounts.find((a) => a.id === ref) ??
      config.accounts.find((a) => a.email.trim() !== '' && a.email.trim().toLowerCase() === ref.toLowerCase())
    return selected ? { config: selected, error: '', warning: '' } : {
      config: undefined,
      error: '账号不存在：' + ref + '。可选账号：' + (config.accounts.map((a) => a.id + ' (' + a.email + ')').join('、') || '(无)'),
      warning: '',
    }
  }
  const selected = config.accounts.find((a) => a.id === config.defaultAccount) ?? config.accounts[0]
  return {
    config: selected, error: '',
    warning: config.defaultAccount !== '' && selected?.id !== config.defaultAccount
      ? '配置的默认账号不存在，已回落到 ' + (selected ? selected.id + ' (' + selected.email.trim() + ')' : '(无账号)') : '',
  }
}

// Serialize read/modify/write across all Store instances using this file.
const revisions = new Map<string, number>()
const writes = new Map<string, Promise<unknown>>()
const listeners = new Map<string, Set<(emails: string[]) => Promise<void>>>()

async function temporaryFile(file: string, bytes: string | Buffer): Promise<string> {
  const temp = file + '.' + randomUUID() + '.tmp'
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  } finally {
    await handle.close()
  }
  return temp
}

/** Sync directory entries so a published backup precedes replacement on disk. */
async function syncDirectory(file: string): Promise<void> {
  const directory = await open(path.dirname(file), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function backupV1(file: string, bytes: Buffer): Promise<void> {
  const backup = file + '.v1.bak'
  try {
    await stat(backup)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temp = await temporaryFile(backup, bytes)
  try {
    // Publish a complete file atomically without ever replacing a prior backup.
    await link(temp, backup)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    await unlink(temp)
  }
}

/** Mask a secret for display: never more than 4 leading characters. */
export function maskSecret(value: string): string {
  if (value === '') return ''
  const head = value.slice(0, 4)
  return head + '…（' + String(value.length) + ' 位）'
}

/**
 * Config store with lazy cached reads.
 *
 * `rowReadOnly` is the composition row's seed, applied when the store has no
 * explicit opinion (mirrors how dsh-zhihu seeds its readOnly from the row).
 */
export class MailStore {
  private cached: MailConfig | null = null
  private revision = 0

  /** Current config file path (honors the DSH_QQMAIL_CONFIG override). */
  readonly file: string = path.resolve(configPath())

  /**
   * @param rowReadOnly - seed from the composition row (default true).
   */
  constructor(private readonly rowReadOnly: boolean = true) {}

  /** Read the config (lazy, cached; never throws). */
  async read(): Promise<MailConfig> {
    return this.readSync()
  }

  /** Synchronous read, so the mount path can resolve readOnly before effects. */
  readSync(): MailConfig {
    const revision = revisions.get(this.file) ?? 0
    if (this.revision !== revision) { this.cached = null; this.revision = revision }
    if (this.cached !== null) return this.cached
    try {
      const raw = readFileSync(this.file, 'utf8')
      this.cached = coerce(JSON.parse(raw) as unknown)
    } catch {
      // Missing or corrupt config: fall back to defaults rather than crashing.
      this.cached = empty()
    }
    return this.cached
  }

  /** Effective readOnly plus its provenance. */
  readOnlySync(): { value: boolean; source: 'store' | 'row' | 'default' } {
    const config = this.readSync()
    if (config.readOnly !== undefined) return { value: config.readOnly, source: 'store' }
    if (this.rowReadOnly === false) return { value: false, source: 'row' }
    return { value: true, source: 'default' }
  }

  /** Effective readOnly plus its provenance (async facade). */
  async readOnly(): Promise<{ value: boolean; source: 'store' | 'row' | 'default' }> {
    return this.readOnlySync()
  }

  /** Resolve the IMAP endpoint (preset defaults plus per-field overrides). */
  imapSettings(config: AccountConfig): ServerSettings {
    const preset = PRESETS[config.preset].imap
    return {
      host: config.imapHost.trim() !== '' ? config.imapHost.trim() : preset.host,
      port: config.imapPort > 0 ? config.imapPort : preset.port,
      secure: config.imapHost.trim() !== '' ? config.imapSecure : preset.secure,
    }
  }

  /** Resolve the SMTP endpoint (preset defaults plus per-field overrides). */
  smtpSettings(config: AccountConfig): ServerSettings {
    const preset = PRESETS[config.preset].smtp
    return {
      host: config.smtpHost.trim() !== '' ? config.smtpHost.trim() : preset.host,
      port: config.smtpPort > 0 ? config.smtpPort : preset.port,
      secure: config.smtpHost.trim() !== '' ? config.smtpSecure : preset.secure,
    }
  }

  /** Whether the stored config has enough to attempt a connection. */
  isConfigured(config: MailConfig, ref?: string): boolean {
    const selected = resolveAccountRef(config, ref)
    if (!selected.config || selected.error) return false
    const account = selected.config
    return (
      account.email.trim() !== '' &&
      account.authCode.trim() !== '' &&
      this.imapSettings(account).host !== '' &&
      this.smtpSettings(account).host !== ''
    )
  }

  /**
   * Resolve the live account.
   * @returns the account, or an error message explaining what is missing.
   */
  account(_view: MailConfigView, plugin: MailConfig, ref?: string): { account: Account; error: string } {
    const selected = resolveAccountRef(plugin, ref)
    if (selected.error) return { account: placeholderAccount(), error: selected.error }
    const config = selected.config ?? emptyAccount()
    const view = { email: config.email }
    if (view.email.trim() === '') {
      return { account: placeholderAccount(), error: '尚未配置邮箱地址：请先用 qqmail_config 设置 email（或在设置面板填写）。' }
    }
    if (config.authCode.trim() === '') {
      return {
        account: placeholderAccount(),
        error:
          '尚未配置授权码：' +
          PRESETS[config.preset].credentialHint +
          '（qqmail_config 的 authCode 参数，或在设置面板填写。）',
      }
    }
    const imap = this.imapSettings(config)
    const smtp = this.smtpSettings(config)
    if (imap.host === '' || smtp.host === '') {
      return { account: placeholderAccount(), error: 'IMAP/SMTP 服务器地址为空：自定义服务商需填写 imapHost 与 smtpHost。' }
    }
    return {
      account: {
        email: view.email.trim(),
        authCode: config.authCode,
        imap,
        smtp,
        smtpRequireTls: config.smtpRequireTls,
        fromName: config.fromName,
        signature: config.signature,
        sentFolder: config.sentFolder.trim(),
        timeoutMs: config.timeoutMs,
        maxParseMb: config.maxParseMb,
        maxSendMb: config.maxSendMb,
        downloadDir: config.downloadDir,
        previewInList: config.previewInList,
        saveSent: config.saveSent,
      },
      error: '',
    }
  }

  /** Public secret-free view. */
  view(ref?: string): MailConfigView {
    const selected = resolveAccountRef(this.readSync(), ref)
    if (selected.error) throw new Error(selected.error)
    const config = selected.config ?? emptyAccount()
    const readOnly = this.readOnlySync()
    const imap = this.imapSettings(config)
    const smtp = this.smtpSettings(config)
    const storedAny =
      config.email !== '' ||
      config.authCode !== '' ||
      config.imapHost !== '' ||
      config.smtpHost !== '' ||
      config.fromName !== '' ||
      config.signature !== '' ||
      config.downloadDir !== '' ||
      config.sentFolder !== '' ||
      config.preset !== 'qq' ||
      this.readSync().readOnly !== undefined ||
      config.previewInList ||
      !config.saveSent
    return {
      configured: storedAny,
      preset: config.preset,
      presetLabel: PRESETS[config.preset].label,
      email: config.email,
      authCodeSet: config.authCode !== '',
      authCodeHint: maskSecret(config.authCode),
      credentialHint: PRESETS[config.preset].credentialHint,
      imap,
      smtp,
      smtpRequireTls: config.smtpRequireTls,
      fromName: config.fromName,
      signature: config.signature,
      sentFolder: config.sentFolder,
      downloadDir: config.downloadDir,
      readOnly: readOnly.value,
      readOnlySource: readOnly.source,
      timeoutMs: config.timeoutMs,
      maxParseMb: config.maxParseMb,
      maxSendMb: config.maxSendMb,
      previewInList: config.previewInList,
      saveSent: config.saveSent,
      configPath: this.file,
    }
  }

  /** Secret-free multi-account view; the legacy default view stays unchanged. */
  listAccounts(): { version: 2; defaultAccount: string; resolvedDefaultAccount: string; warning: string; accounts: (MailConfigView & { id: string; label: string })[] } {
    const config = this.readSync()
    const selected = resolveAccountRef(config)
    return {
      version: 2, defaultAccount: config.defaultAccount,
      resolvedDefaultAccount: selected.config?.id ?? '', warning: selected.warning,
      accounts: config.accounts.map((a) => ({ id: a.id, label: a.label, ...this.view(a.id) })),
    }
  }

  /** Core hook: all successful writes, including direct patch callers. */
  onAccountsChanged(listener: (emails: string[]) => Promise<void>): () => void {
    let set = listeners.get(this.file)
    if (!set) { set = new Set(); listeners.set(this.file, set) }
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(this.file)
    }
  }

  /** Persist in a file-scoped queue; a failed write never poisons the queue. */
  async patch(patch: ConfigPatch): Promise<MailConfigView> {
    const prior = writes.get(this.file) ?? Promise.resolve()
    const task = prior.catch(() => undefined).then(() => this.applyPatch(patch))
    writes.set(this.file, task)
    try { return await task } finally {
      if (writes.get(this.file) === task) writes.delete(this.file)
    }
  }

  private async applyPatch(patch: ConfigPatch): Promise<MailConfigView> {
    let bytes: Buffer | undefined
    let raw: Record<string, unknown> | undefined
    let plugin = empty()
    try {
      bytes = await readFile(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (bytes !== undefined) {
      try {
        raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
        plugin = coerce(raw)
      } catch {
        throw new Error('配置损坏或版本不支持，拒绝覆盖；请先备份并修复配置文件。')
      }
    }
    let next: MailConfig = { ...plugin, accounts: [...plugin.accounts] }
    let resultRef: string | undefined
    if (patch.reset === true && patch.account === undefined) {
      next = empty()
    } else if (patch.remove === true) {
      if (patch.confirm !== true || patch.account === undefined) throw new Error('删除账号需要 account 和 confirm: true。')
      const selected = resolveAccountRef(plugin, patch.account)
      if (selected.error) throw new Error(selected.error)
      next.accounts = next.accounts.filter((a) => a.id !== selected.config!.id)
      // Retain a stale default reference so status can explain the fallback.
    } else {
      const adding = patch.account === '__new__'
      const selected = adding ? undefined : resolveAccountRef(plugin, patch.account)
      if (selected?.error) throw new Error(selected.error)
      let current = selected?.config
      const accountKeys = ['id', 'label', 'preset', 'email', 'authCode', 'imapHost', 'imapPort', 'imapSecure', 'smtpHost', 'smtpPort', 'smtpSecure', 'smtpRequireTls', 'fromName', 'signature', 'sentFolder', 'downloadDir', 'timeoutMs', 'maxParseMb', 'maxSendMb', 'previewInList', 'saveSent'] as const
      const accountPatch = adding || patch.reset === true || accountKeys.some((k) => patch[k] !== undefined)
      if (accountPatch) {
        if (!current) {
          if (next.accounts.length >= MAX_ACCOUNTS) throw new Error('账号数量超过上限 10。')
          const id = patch.id ?? deriveId(patch.email ?? '', new Set(next.accounts.map((a) => a.id)))
          current = emptyAccount(id)
        }
        if ((adding || !selected?.config) && next.accounts.some((a) => a.id === current!.id)) throw new Error('账号 id 重复。')
        const beforeId = current.id
        if (patch.reset === true) current = emptyAccount(current.id)
        const auto = patch.email !== undefined && patch.preset === undefined
        const updated: AccountConfig = {
          id: patch.id ?? current.id,
          label: patch.label ?? current.label,
          // Setting a new address re-detects the provider unless one was given.
          preset:
            patch.preset !== undefined
              ? patch.preset
              : auto
                ? detectPreset(patch.email ?? '')
                : current.preset,
          email: patch.email !== undefined ? patch.email.trim() : current.email,
          authCode: patch.authCode !== undefined ? patch.authCode.trim() : current.authCode,
          imapHost: patch.imapHost !== undefined ? patch.imapHost.trim() : current.imapHost,
          imapPort: patch.imapPort !== undefined ? patch.imapPort : current.imapPort,
          imapSecure: patch.imapSecure !== undefined ? patch.imapSecure : current.imapSecure,
          smtpHost: patch.smtpHost !== undefined ? patch.smtpHost.trim() : current.smtpHost,
          smtpPort: patch.smtpPort !== undefined ? patch.smtpPort : current.smtpPort,
          smtpSecure: patch.smtpSecure !== undefined ? patch.smtpSecure : current.smtpSecure,
          smtpRequireTls: patch.smtpRequireTls !== undefined ? patch.smtpRequireTls : current.smtpRequireTls,
          fromName: patch.fromName !== undefined ? patch.fromName : current.fromName,
          signature: patch.signature !== undefined ? patch.signature : current.signature,
          sentFolder: patch.sentFolder !== undefined ? patch.sentFolder.trim() : current.sentFolder,
          downloadDir: patch.downloadDir !== undefined ? patch.downloadDir.trim() : current.downloadDir,
          timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeoutMs,
          maxParseMb: patch.maxParseMb !== undefined ? patch.maxParseMb : current.maxParseMb,
          maxSendMb: patch.maxSendMb !== undefined ? patch.maxSendMb : current.maxSendMb,
          previewInList: patch.previewInList !== undefined ? patch.previewInList : current.previewInList,
          saveSent: patch.saveSent !== undefined ? patch.saveSent : current.saveSent,
        }
        if (!validId(updated.id)) throw new Error('账号 id 仅允许 [a-z0-9._-]，长度 1~64，且不能为 __new__。')
        if (next.accounts.some((a) => a.id === updated.id && a.id !== beforeId)) throw new Error('账号 id 重复。')
        const index = next.accounts.findIndex((a) => a.id === beforeId)
        if (index < 0) next.accounts.push(updated)
        else next.accounts[index] = updated
        if (next.defaultAccount === '' || next.defaultAccount === beforeId) next.defaultAccount = updated.id
        resultRef = updated.id
      }
      if (patch.readOnly !== undefined) next.readOnly = patch.readOnly
    }
    if (patch.defaultAccount !== undefined) {
      const selected = resolveAccountRef(next, patch.defaultAccount)
      if (selected.error) throw new Error(selected.error)
      next.defaultAccount = selected.config!.id
    }
    // Validate and normalize before any filesystem mutation.
    next = coerce(next)
    const affected = new Set<string>()
    for (const old of plugin.accounts) {
      const updated = next.accounts.find((a) => a.id === old.id)
      if (JSON.stringify(old) !== JSON.stringify(updated)) {
        affected.add(old.email.trim())
        if (updated) affected.add(updated.email.trim())
      }
    }
    await mkdir(path.dirname(this.file), { recursive: true })
    if (bytes !== undefined && raw?.version !== 2) {
      await backupV1(this.file, bytes)
      await syncDirectory(this.file)
    }
    const temp = await temporaryFile(this.file, JSON.stringify(next, null, 2) + '\n')
    try { await rename(temp, this.file) } finally { await unlink(temp).catch(() => undefined) }
    this.cached = next
    // Clear cached reads in other Store instances on their next read (see below).
    revisions.set(this.file, (revisions.get(this.file) ?? 0) + 1)
    this.revision = revisions.get(this.file)!
    await Promise.all([...listeners.get(this.file) ?? []].map((fn) => fn([...affected])))
    try { await syncDirectory(this.file) } catch {
      throw new Error('配置已保存，但目录同步失败；请检查文件系统并重新读取配置。')
    }
    return this.view(resultRef)
  }

  /** Drop the cached config (used after external edits in tests). */
  invalidate(): void {
    this.cached = null
  }
}

/** Account stand-in used when the caller only needs shapes, not credentials. */
function placeholderAccount(): Account {
  return {
    email: '',
    authCode: '',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    smtpRequireTls: true,
    fromName: '',
    signature: '',
    sentFolder: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxParseMb: DEFAULT_MAX_PARSE_MB,
    maxSendMb: DEFAULT_MAX_SEND_MB,
    downloadDir: '',
    previewInList: false,
    saveSent: true,
  }
}

/** Whether the config file exists on disk (used by the status route). */
export async function configExists(file: string): Promise<{ exists: boolean; mtime: string }> {
  try {
    const info = await stat(file)
    return { exists: true, mtime: info.mtime.toISOString() }
  } catch {
    return { exists: false, mtime: '' }
  }
}

/** Read the raw config text (diagnostics only; never returned to a model). */
export async function readRawConfig(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}
