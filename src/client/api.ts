/**
 * dsh-qqmail — browser-side API client for the /api/dsh-qqmail route family.
 *
 * The only data access path the panel uses: plain fetch, same origin. The
 * payloads mirror the host contracts exactly, because the routes run the very
 * same tool specs the agent calls — there is no second, thinner implementation
 * that could drift out of sync.
 */

/** One IMAP/SMTP endpoint. */
export interface ServerSettings {
  host: string
  port: number
  secure: boolean
}

/** One provider preset offered by the host. */
export interface PresetInfo {
  id: string
  label: string
  imap: ServerSettings
  smtp: ServerSettings
  credentialHint: string
}

/** Connect-and-authenticate probe outcome. */
export interface ProbeResult {
  ok: boolean
  imapOk: boolean
  smtpOk: boolean
  imapError: string
  smtpError: string
  mailboxCount: number
  sentFolder: string
}

export interface AccountIdentity { id: string; email: string }

/** The secret-free configuration view. */
export interface ConfigView {
  configured: boolean
  preset: string
  presetLabel: string
  email: string
  authCodeSet: boolean
  authCodeHint: string
  credentialHint: string
  imap: ServerSettings
  smtp: ServerSettings
  fromName: string
  signature: string
  sentFolder: string
  downloadDir: string
  readOnly: boolean
  readOnlySource: string
  timeoutMs: number
  maxParseMb: number
  maxSendMb: number
  previewInList: boolean
  saveSent: boolean
  configPath: string
  account?: AccountIdentity
  probe?: ProbeResult
}

/** Response of GET /api/dsh-qqmail/status. */
export interface StatusResponse {
  ok: boolean
  message: string
  data: ConfigView
  presets: PresetInfo[]
  readOnly: boolean
}

export interface AccountView extends ConfigView { id: string; label: string }
export interface AccountsView {
  version: 2
  defaultAccount: string
  resolvedDefaultAccount: string
  warning: string
  accounts: AccountView[]
}
export interface AccountsResponse { ok: boolean; message: string; data: AccountsView }
export interface ConfigResponse { ok: boolean; message: string; data?: ConfigView }
export interface ProbeResponse extends ConfigResponse {}

/** One mailbox folder. */
export interface MailboxInfo {
  path: string
  name: string
  specialUse: string
  subscribed: boolean
  messages: number
  unseen: number
}

/** One address. */
export interface MessageAddress {
  name: string
  address: string
}

/** One attachment descriptor. */
export interface AttachmentMeta {
  index: number
  filename: string
  contentType: string
  size: number
  contentId: string
  inline: boolean
}

/** A message as it appears in a list. */
export interface MessageSummary {
  uid: number
  mailbox: string
  subject: string
  from: MessageAddress[]
  to: MessageAddress[]
  date: string
  size: number
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  preview: string
  messageId: string
}

/** A full message. */
export interface MessageDetail extends MessageSummary {
  cc: MessageAddress[]
  bcc: MessageAddress[]
  replyTo: MessageAddress[]
  text: string
  html: string
  attachments: AttachmentMeta[]
  inReplyTo: string
  references: string[]
}

/** Payload of the list / search / read routes. */
export interface ToolPayload {
  ok: boolean
  message: string
  data?: {
    account?: AccountIdentity
    mailbox?: string
    mode?: string
    total?: number
    truncated?: boolean
    items?: MessageSummary[] | MessageDetail[]
    errors?: string[]
    mailboxes?: MailboxInfo[]
    count?: number
  }
}

/** Error carrying the route's JSON error message. */
export class QqmailApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QqmailApiError'
  }
}

/** Plain fetch helper with an error wrapper. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    throw new QqmailApiError('网络请求失败：' + String(error instanceof Error ? error.message : error))
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new QqmailApiError('HTTP ' + String(response.status) + '：响应不是合法 JSON')
  }
  if (!response.ok) {
    // The host registers plugin routes at boot, so a route added since the last
    // start falls through to the shell's handler (401/404) instead of reaching
    // the plugin. Say that plainly rather than showing a bare status code.
    if (response.status === 401 || response.status === 404) {
      throw new QqmailApiError('该能力需要重启 dsh web 后才能用（host 端路由尚未注册）。')
    }
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'HTTP ' + String(response.status)
    throw new QqmailApiError(message)
  }
  return body as T
}

/** The dsh-qqmail panel API. */
export class QqmailApi {
  /** Plugin + account status; `probe` really connects to both servers. */
  async status(probe = false, account?: string): Promise<StatusResponse> {
    const query = new URLSearchParams()
    if (probe) query.set('probe', '1')
    if (account !== undefined) query.set('account', account)
    return request<StatusResponse>('/api/dsh-qqmail/status' + (query.size ? '?' + query.toString() : ''))
  }

  /** Persist a config patch. */
  async setConfig(patch: Record<string, unknown>, account?: string): Promise<ConfigResponse> {
    return request<ConfigResponse>('/api/dsh-qqmail/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account === undefined ? patch : { ...patch, account }),
    })
  }

  /** Real connect-and-authenticate check. */
  async probe(account?: string): Promise<ProbeResponse> {
    return request('/api/dsh-qqmail/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account === undefined ? {} : { account }) })
  }

  async accounts(): Promise<AccountsResponse> { return request('/api/dsh-qqmail/accounts') }

  async accountsAction(payload: { action: 'add'; [key: string]: unknown }): Promise<ConfigResponse>
  async accountsAction(payload: { action: 'setDefault' | 'remove'; account: string; confirm?: boolean }): Promise<AccountsResponse>
  async accountsAction(payload: { action: 'add' | 'setDefault' | 'remove'; account?: string; confirm?: boolean; [key: string]: unknown }): Promise<AccountsResponse | ConfigResponse> {
    return request('/api/dsh-qqmail/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  }

  /** List folders. */
  async folders(account?: string): Promise<ToolPayload> {
    return request<ToolPayload>('/api/dsh-qqmail/folders?status=1' + (account === undefined ? '' : '&account=' + encodeURIComponent(account)))
  }

  /** List messages. */
  async list(params: { mailbox?: string; limit?: number; unseen?: boolean; account?: string } = {}): Promise<ToolPayload> {
    const query = new URLSearchParams()
    if (params.account !== undefined) query.set('account', params.account)
    if (params.mailbox !== undefined) query.set('mailbox', params.mailbox)
    query.set('limit', String(params.limit ?? 20))
    if (params.unseen === true) query.set('unseen', '1')
    return request<ToolPayload>('/api/dsh-qqmail/list?' + query.toString())
  }

  /** Search messages. */
  async search(keyword: string, mailbox: string, limit = 20, account?: string): Promise<ToolPayload> {
    const query = new URLSearchParams({ q: keyword, mailbox, limit: String(limit) })
    if (account !== undefined) query.set('account', account)
    return request<ToolPayload>('/api/dsh-qqmail/search?' + query.toString())
  }

  /** Read one message. */
  async read(uid: number, mailbox: string, account?: string): Promise<ToolPayload> {
    const query = new URLSearchParams({ uid: String(uid), mailbox, maxBodyChars: '20000' })
    if (account !== undefined) query.set('account', account)
    return request<ToolPayload>('/api/dsh-qqmail/read?' + query.toString())
  }

  /** Set flags on one message. */
  async mark(payload: { account?: string; uid: number; mailbox: string; seen?: boolean; flagged?: boolean }): Promise<{ ok: boolean; message: string }> {
    return request('/api/dsh-qqmail/mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  /** Send a message. */
  async send(payload: {
    account?: string
    to: string[]
    cc?: string[]
    subject: string
    text: string
  }): Promise<{ ok: boolean; message: string }> {
    return request('/api/dsh-qqmail/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }
}

/** Render one address list as `Name <addr>`. */
export function addressLabel(list: readonly MessageAddress[]): string {
  const first = list[0]
  if (first === undefined) return '(未知)'
  return first.name !== '' ? first.name + ' <' + first.address + '>' : first.address
}

/** Human-readable byte size. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return String(Math.round(bytes)) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

/** Local `YYYY-MM-DD HH:mm` rendering. */
export function formatDate(iso: string): string {
  if (iso === '') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  )
}
