/**
 * dsh-qqmail — SMTP layer.
 *
 * Composes one message with nodemailer's MailComposer so the *same* raw bytes
 * are both handed to the SMTP server and appended to the Sent folder. Building
 * the message twice (once to send, once to archive) would produce two different
 * Message-IDs for one mail, which breaks thread grouping in every client that
 * later reads the Sent copy.
 */

import { createTransport, type Transporter } from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'

import { singleLine } from './mime.ts'
import type { OutgoingMessage, SendResult } from './types.ts'

/** Endpoint + credentials for one SMTP server. */
export interface SmtpEndpoint {
  host: string
  port: number
  /** Implicit TLS (port 465). false = STARTTLS upgrade (port 587). */
  secure: boolean
  user: string
  pass: string
  timeoutMs: number
  /** Require the STARTTLS upgrade on a non-secure port (default true). */
  requireTls: boolean
}

/**
 * Turn an SMTP failure into something a user can act on.
 * @param error - whatever verify()/sendMail() rejected with.
 */
export function describeSmtpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: string; responseCode?: number } | null)?.code ?? ''
  if (/EAUTH|535|Invalid login|authentication/i.test(raw + ' ' + code)) {
    return (
      'SMTP 认证失败：QQ 邮箱要求用 16 位**授权码**（不是 QQ 密码），并在网页版「设置 → 账号 → IMAP/SMTP服务」开启服务。原始错误：' +
      raw
    )
  }
  if (/ETIMEDOUT|timeout|ESOCKET/i.test(raw + ' ' + code)) {
    return 'SMTP 连接超时：检查网络与端口（QQ 邮箱 SMTP 用 smtp.qq.com:465 SSL，或 587 STARTTLS）。原始错误：' + raw
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return '无法解析 SMTP 服务器地址：检查 smtpHost 拼写与网络。原始错误：' + raw
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return 'SMTP 连接被拒绝：端口不对或被防火墙拦截。原始错误：' + raw
  }
  if (/EENVELOPE|no recipients|550|553|554/i.test(raw + ' ' + code)) {
    return '收件人被服务器拒绝：检查地址是否有效（也可能被对方服务器反垃圾策略拦截）。原始错误：' + raw
  }
  if (/certificate/i.test(raw)) {
    return 'TLS 证书校验失败：确认 SMTP 服务器证书有效（插件不放宽证书校验）。原始错误：' + raw
  }
  return raw
}

/** Build one SMTP transporter (never pooled: each call is short-lived). */
export function makeTransport(endpoint: SmtpEndpoint): Transporter {
  return createTransport({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    auth: { user: endpoint.user, pass: endpoint.pass },
    connectionTimeout: endpoint.timeoutMs,
    greetingTimeout: endpoint.timeoutMs,
    socketTimeout: Math.max(endpoint.timeoutMs, 120_000),
    // On 587 the upgrade must not be optional, or a MITM could force plaintext.
    requireTLS: !endpoint.secure && endpoint.requireTls,
    ...(endpoint.secure ? { tls: { minVersion: 'TLSv1.2' as const } } : {}),
  })
}

/** A composed message: the exact bytes plus the SMTP envelope to send them with. */
export interface ComposedMessage {
  raw: Buffer
  envelope: { from: string; to: string[] }
  /** Nominal size in bytes (the raw length). */
  size: number
}

/**
 * Build the raw message once.
 * @param from - sender address plus display name.
 * @param message - the outgoing message.
 * @returns the raw bytes and the envelope they must be sent with.
 */
export async function composeMessage(
  from: { name: string; address: string },
  message: OutgoingMessage,
): Promise<ComposedMessage> {
  const composer = new MailComposer({
    from: from.name !== '' ? { name: singleLine(from.name), address: from.address } : from.address,
    to: message.to,
    ...(message.cc.length > 0 ? { cc: message.cc } : {}),
    ...(message.bcc.length > 0 ? { bcc: message.bcc } : {}),
    subject: singleLine(message.subject),
    text: message.text,
    ...(message.html !== '' ? { html: message.html } : {}),
    ...(message.attachments.length > 0
      ? {
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename,
            path: attachment.path,
            ...(attachment.contentType !== undefined ? { contentType: attachment.contentType } : {}),
          })),
        }
      : {}),
    ...(message.inReplyTo !== '' ? { inReplyTo: message.inReplyTo } : {}),
    ...(message.references.length > 0 ? { references: message.references } : {}),
  })
  const raw = await composer.compile().build()
  // Bcc recipients belong in the envelope only — nodemailer strips the header.
  const recipients = [...message.to, ...message.cc, ...message.bcc]
  return { raw, envelope: { from: from.address, to: recipients }, size: raw.length }
}

/**
 * Send one composed message.
 * @param endpoint - SMTP credentials.
 * @param composed - the composed message.
 * @returns the normalized send result (without the Sent-folder copy).
 */
export async function sendComposed(
  endpoint: SmtpEndpoint,
  composed: ComposedMessage,
): Promise<SendResult> {
  const transporter = makeTransport(endpoint)
  try {
    const info = (await transporter.sendMail({
      envelope: composed.envelope,
      raw: composed.raw,
    })) as {
      messageId?: string
      response?: string
      accepted?: unknown[]
      rejected?: unknown[]
    }
    const toStrings = (value: unknown[] | undefined): string[] =>
      (value ?? []).map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))
    return {
      messageId: typeof info.messageId === 'string' ? info.messageId : '',
      response: typeof info.response === 'string' ? info.response : '',
      accepted: toStrings(info.accepted),
      rejected: toStrings(info.rejected),
      savedTo: '',
      saveError: '',
    }
  } finally {
    transporter.close()
  }
}

/** Probe the SMTP connection. */
export async function verifySmtp(endpoint: SmtpEndpoint): Promise<{ ok: boolean; error: string }> {
  const transporter = makeTransport(endpoint)
  try {
    await transporter.verify()
    return { ok: true, error: '' }
  } catch (error) {
    return { ok: false, error: describeSmtpError(error) }
  } finally {
    transporter.close()
  }
}
