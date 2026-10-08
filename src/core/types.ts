/**
 * dsh-qqmail — shared value types for the mailbox core.
 *
 * Everything here is plain data: the agent tools, the loopback routes, the CLI
 * and the MCP stdio server all render these same shapes, so a payload the model
 * sees and a payload the CLI prints can never drift apart.
 */

/** Known provider presets. `custom` means "whatever the user typed". */
export type PresetId = 'qq' | 'qq-exmail' | '163' | '126' | 'gmail' | 'outlook' | 'custom'

/** One IMAP or SMTP endpoint. */
export interface ServerSettings {
  host: string
  port: number
  /** TLS on connect (implicit TLS). false = STARTTLS / plain upgrade. */
  secure: boolean
}

/** A fully resolved account, ready to hand to the core. */
export interface Account {
  downloadDir: string
  previewInList: boolean
  saveSent: boolean
  /** Mailbox login (the full address, e.g. `someone@qq.com`). */
  email: string
  /** QQ Mail IMAP/SMTP authorization code (NOT the account password). */
  authCode: string
  imap: ServerSettings
  smtp: ServerSettings
  /**
   * Require a STARTTLS upgrade on a non-secure SMTP port.
   *
   * true (default) refuses to send a password or a message over a plaintext
   * session, which is what protects against a downgrade attack on port 587.
   * Only turn it off for a server that genuinely speaks plaintext (a local
   * relay, or an appliance that never offered TLS).
   */
  smtpRequireTls: boolean
  /** Display name used in the From header ('' = no display name). */
  fromName: string
  /** Plain-text signature appended to outgoing bodies ('' = none). */
  signature: string
  /** Mailbox path for the Sent copy of an outgoing message ('' = auto-detect). */
  sentFolder: string
  /** Hard timeout for one connect / command round trip (ms). */
  timeoutMs: number
  /** Refuse to parse a message whose raw source exceeds this (MB). */
  maxParseMb: number
  /** Refuse to upload one outgoing message whose raw source exceeds this (MB). */
  maxSendMb: number
}

/** One email address with an optional display name. */
export interface MessageAddress {
  name: string
  address: string
}

/** One mailbox folder. */
export interface MailboxInfo {
  /** IMAP path, already decoded from modified UTF-7 (`已发送` not `&XfJT0ZAB-`). */
  path: string
  /** Leaf name as reported by the server. */
  name: string
  /** SPECIAL-USE flag (`\Sent`, `\Drafts`, `\Trash`, `\Junk`, …) or ''. */
  specialUse: string
  /** Server flags (`\Noselect`, `\HasChildren`, …). */
  flags: string[]
  /** Whether the folder is subscribed. */
  subscribed: boolean
  /** Message count from STATUS when it was cheap to ask, else -1. */
  messages: number
  /** Unseen count from STATUS, else -1. */
  unseen: number
}

/** One attachment descriptor (never the bytes). */
export interface AttachmentMeta {
  /** 1-based index used by `qqmail_attachment` to pick the attachment. */
  index: number
  filename: string
  contentType: string
  /** Size in bytes as reported by the MIME part. */
  size: number
  /** Content-ID for inline images ('' when not inline). */
  contentId: string
  /** True when the part is an inline image referenced by the HTML body. */
  inline: boolean
}

/** A compact message as it appears in a list. */
export interface MessageSummary {
  /** IMAP UID inside its mailbox — the stable handle every tool takes. */
  uid: number
  mailbox: string
  subject: string
  from: MessageAddress[]
  to: MessageAddress[]
  /** ISO 8601 timestamp. */
  date: string
  /** Raw size in bytes. */
  size: number
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
  /** Short plain-text preview ('' unless the caller asked for bodies). */
  preview: string
  messageId: string
}

/** A full message. */
export interface MessageDetail extends MessageSummary {
  cc: MessageAddress[]
  bcc: MessageAddress[]
  replyTo: MessageAddress[]
  /** Plain-text body (derived from HTML when the mail is HTML-only). */
  text: string
  /** Raw HTML body ('' unless requested and present). */
  html: string
  attachments: AttachmentMeta[]
  inReplyTo: string
  references: string[]
}

/** Search criteria shared by the tool, the routes and the CLI. */
export interface SearchQuery {
  mailbox: string
  /** Match the From header (ASCII only when sent to the server). */
  from: string
  /** Match the To header. */
  to: string
  /** Match the Subject header. */
  subject: string
  /** Match the body. */
  body: string
  /** Full-text (headers + body). */
  text: string
  /** ISO date or YYYY-MM-DD; messages on/after this date. */
  since: string
  /** ISO date or YYYY-MM-DD; messages strictly before this date. */
  before: string
  /** Only unseen messages. */
  unseen: boolean
  /** Only flagged (starred) messages. */
  flagged: boolean
  /** Only messages larger than this many bytes. */
  larger: number
  /** Only messages smaller than this many bytes. */
  smaller: number
}

/** How a search was actually executed. */
export type SearchMode = 'server' | 'local'

/** Result of a search or a listing. */
export interface SearchResult {
  mailbox: string
  /** 'server' = IMAP SEARCH; 'local' = fetched a window and filtered in-process. */
  mode: SearchMode
  /** Total matches before the limit was applied. */
  total: number
  /** True when more matches existed than were returned. */
  truncated: boolean
  items: MessageSummary[]
}

/** One outgoing attachment. */
export interface OutgoingAttachment {
  filename: string
  /** Absolute path on disk. */
  path: string
  contentType?: string
}

/** One outgoing message. */
export interface OutgoingMessage {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  text: string
  html: string
  attachments: OutgoingAttachment[]
  /** Value for the In-Reply-To header. */
  inReplyTo: string
  /** Values for the References header. */
  references: string[]
  /** When set, overrides the account's Sent-folder copy decision. */
  saveSent: boolean | undefined
}

/** Outcome of one send. */
export interface SendResult {
  messageId: string
  /** SMTP server response summary. */
  response: string
  accepted: string[]
  rejected: string[]
  /** Where the Sent copy landed ('' when none was written). */
  savedTo: string
  /** Non-fatal problem with the Sent copy ('' when none). */
  saveError: string
}

/** One page of headers, used by the local-filter fallback. */
export interface HeaderWindow {
  uid: number
  subject: string
  from: MessageAddress[]
  to: MessageAddress[]
  date: string
  seen: boolean
  flagged: boolean
  size: number
}

/** Connect-and-authenticate probe outcome. */
export interface ProbeResult {
  ok: boolean
  imapOk: boolean
  smtpOk: boolean
  imapError: string
  smtpError: string
  /** Capability string reported by the IMAP server ('' when unknown). */
  capabilities: string
  /** Mailbox count discovered during the probe. */
  mailboxCount: number
  /** Folder the plugin would use for the Sent copy ('' when none resolved). */
  sentFolder: string
}
