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

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
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
export interface MailConfig {
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
  /** Monthly/quota-free switch: true = read-only tool roster. */
  readOnly: boolean | undefined
  timeoutMs: number
  maxParseMb: number
  maxSendMb: number
  /** Include a body preview in list results (adds one part fetch per message). */
  previewInList: boolean
  /** Save a copy of outgoing mail into the Sent folder. */
  saveSent: boolean
}

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
function empty(): MailConfig {
  return {
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
    readOnly: undefined,
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
function coerce(raw: unknown): MailConfig {
  const base = empty()
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
    readOnly: typeof obj.readOnly === 'boolean' ? obj.readOnly : undefined,
    timeoutMs: num(obj.timeoutMs, base.timeoutMs, 1_000, 600_000),
    maxParseMb: num(obj.maxParseMb, base.maxParseMb, 1, 500),
    maxSendMb: num(obj.maxSendMb, base.maxSendMb, 1, 500),
    previewInList: bool(obj.previewInList, base.previewInList),
    saveSent: bool(obj.saveSent, base.saveSent),
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

  /** Current config file path (honors the DSH_QQMAIL_CONFIG override). */
  readonly file: string = configPath()

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
  imapSettings(config: MailConfig): ServerSettings {
    const preset = PRESETS[config.preset].imap
    return {
      host: config.imapHost.trim() !== '' ? config.imapHost.trim() : preset.host,
      port: config.imapPort > 0 ? config.imapPort : preset.port,
      secure: config.imapHost.trim() !== '' ? config.imapSecure : preset.secure,
    }
  }

  /** Resolve the SMTP endpoint (preset defaults plus per-field overrides). */
  smtpSettings(config: MailConfig): ServerSettings {
    const preset = PRESETS[config.preset].smtp
    return {
      host: config.smtpHost.trim() !== '' ? config.smtpHost.trim() : preset.host,
      port: config.smtpPort > 0 ? config.smtpPort : preset.port,
      secure: config.smtpHost.trim() !== '' ? config.smtpSecure : preset.secure,
    }
  }

  /** Whether the stored config has enough to attempt a connection. */
  isConfigured(config: MailConfig): boolean {
    return (
      config.email.trim() !== '' &&
      config.authCode.trim() !== '' &&
      this.imapSettings(config).host !== '' &&
      this.smtpSettings(config).host !== ''
    )
  }

  /**
   * Resolve the live account.
   * @returns the account, or an error message explaining what is missing.
   */
  account(view: MailConfigView, config: MailConfig): { account: Account; error: string } {
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
      },
      error: '',
    }
  }

  /** Public secret-free view. */
  view(): MailConfigView {
    const config = this.readSync()
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
      config.readOnly !== undefined ||
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

  /** Persist a patch, or clear everything with reset. */
  async patch(patch: ConfigPatch): Promise<MailConfigView> {
    const current = await this.read()
    let next: MailConfig
    if (patch.reset === true) {
      next = empty()
    } else {
      const auto = patch.email !== undefined && patch.preset === undefined
      next = {
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
        readOnly: patch.readOnly !== undefined ? patch.readOnly : current.readOnly,
        timeoutMs: patch.timeoutMs !== undefined ? patch.timeoutMs : current.timeoutMs,
        maxParseMb: patch.maxParseMb !== undefined ? patch.maxParseMb : current.maxParseMb,
        maxSendMb: patch.maxSendMb !== undefined ? patch.maxSendMb : current.maxSendMb,
        previewInList: patch.previewInList !== undefined ? patch.previewInList : current.previewInList,
        saveSent: patch.saveSent !== undefined ? patch.saveSent : current.saveSent,
      }
    }
    await mkdir(path.dirname(this.file), { recursive: true })
    const serializable: Record<string, unknown> = { ...next }
    // readOnly: undefined is meaningful (fall back to the row seed);
    // JSON.stringify drops undefined keys, which is exactly the wire shape we want.
    if (next.readOnly === undefined) delete serializable.readOnly
    await writeFile(this.file, JSON.stringify(serializable, null, 2) + '\n', { mode: 0o600 })
    this.cached = next
    return this.view()
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
