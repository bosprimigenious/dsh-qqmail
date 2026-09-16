/**
 * dsh-qqmail — message parsing.
 *
 * Wraps mailparser's `simpleParser` and projects its output onto the plugin's
 * own compact shapes. mailparser already derives a plain-text body from HTML
 * (and handles GB2312/GBK charsets), so the plugin does not re-implement MIME
 * decoding — it only decides what the model gets to see.
 */

import { simpleParser, type Attachment, type ParsedMail } from 'mailparser'

import {
  isoDate,
  preview as toPreviewLine,
  safeFilename,
  stripHtml,
  toAddressList,
} from './mime.ts'
import type { AttachmentMeta, MessageAddress, MessageDetail } from './types.ts'

/** Parsed message plus the facts the caller needs about the source buffer. */
export interface ParsedSource {
  parsed: ParsedMail
  /** True when the buffer was cut short before mailparser saw the end. */
  truncated: boolean
  /** Size of the parsed source in bytes. */
  size: number
}

/**
 * Parse a raw RFC 5322 message.
 * @param source - the raw bytes.
 * @param truncated - whether the buffer is known to be incomplete.
 */
export async function parseSource(source: Buffer, truncated = false): Promise<ParsedSource> {
  const parsed = await simpleParser(source, {
    // A malformed part must not abort the whole message: the headers and the
    // text body are still useful to the caller.
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
  })
  return { parsed, truncated, size: source.length }
}

/** Normalize mailparser's attachment list. */
export function toAttachmentMeta(attachments: readonly Attachment[]): AttachmentMeta[] {
  return attachments.map((attachment, index) => {
    const contentId = (attachment.contentId ?? '').replace(/^<|>$/g, '')
    const disposition = attachment.contentDisposition ?? ''
    return {
      index: index + 1,
      filename: safeFilename(attachment.filename ?? '', 'attachment-' + String(index + 1)),
      contentType: attachment.contentType ?? 'application/octet-stream',
      size: typeof attachment.size === 'number' ? attachment.size : attachment.content?.length ?? 0,
      contentId,
      inline: disposition === 'inline' || attachment.related === true,
    }
  })
}

/** Normalize the References header (mailparser yields a string or an array). */
export function toReferences(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()]
  if (!Array.isArray(value)) return []
  return value.map((entry) => String(entry).trim()).filter((entry) => entry !== '')
}

/**
 * Project a parsed message onto {@link MessageDetail}.
 * @param source - parsed message and truncation flag.
 * @param uid - the message's IMAP UID.
 * @param mailbox - the mailbox the UID belongs to.
 * @param flags - seen/flagged/answered flags from the FETCH.
 * @param includeHtml - keep the HTML body (dropped by default to save tokens).
 */
export function toDetail(
  source: ParsedSource,
  uid: number,
  mailbox: string,
  flags: { seen: boolean; flagged: boolean; answered: boolean },
  includeHtml: boolean,
): MessageDetail {
  const { parsed, truncated } = source
  const html = typeof parsed.html === 'string' ? parsed.html : ''
  const text =
    typeof parsed.text === 'string' && parsed.text.trim() !== ''
      ? parsed.text
      : stripHtml(html)
  const from: MessageAddress[] = toAddressList(parsed.from)
  const to: MessageAddress[] = toAddressList(parsed.to)
  const attachments = toAttachmentMeta(parsed.attachments ?? [])
  const dateValue = parsed.date instanceof Date ? parsed.date : undefined
  return {
    uid,
    mailbox,
    subject: parsed.subject !== undefined && parsed.subject !== '' ? parsed.subject : '(无主题)',
    from,
    to,
    cc: toAddressList(parsed.cc),
    bcc: toAddressList(parsed.bcc),
    replyTo: toAddressList(parsed.replyTo),
    date: isoDate(dateValue),
    size: source.size,
    seen: flags.seen,
    flagged: flags.flagged,
    answered: flags.answered,
    hasAttachments: attachments.length > 0,
    preview: toPreviewLine(text, 200),
    messageId: typeof parsed.messageId === 'string' ? parsed.messageId : '',
    inReplyTo: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : '',
    references: toReferences(parsed.references),
    text: truncated ? text + '\n\n[… 邮件过大，正文被截断 …]' : text,
    html: includeHtml ? html : '',
    attachments,
  }
}

/**
 * Best-effort text from a single MIME part fetched with `BODY[1]`.
 *
 * IMAP returns the part with its Content-Transfer-Encoding still applied unless
 * the server negotiated the BINARY extension, and a part fetch carries no MIME
 * headers, so the encoding has to be guessed. This is only used for the optional
 * list preview; a wrong guess yields nothing rather than corrupt text.
 * @param part - the raw part bytes, or undefined when the server sent none.
 */
export function decodePreviewPart(part: Buffer | undefined): string {
  if (part === undefined || part.length === 0) return ''
  const raw = part.toString('utf8')
  if (/=[0-9A-F]{2}/i.test(raw) || /=\r?\n/.test(raw)) return toPreviewLine(decodeQuotedPrintable(raw), 140)
  // A base64 body has no spaces and only base64 characters; ordinary prose fails
  // this test within the first line, prose with CJK characters fails it too.
  const head = raw.slice(0, 400)
  if (/^[A-Za-z0-9+/\r\n=]+$/.test(head)) {
    try {
      const decoded = Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8')
      if (!decoded.includes('\uFFFD')) return toPreviewLine(decoded, 140)
    } catch {
      return ''
    }
  }
  return toPreviewLine(raw, 140)
}

/** Decode quoted-printable text (soft line breaks + `=XX` escapes). */
export function decodeQuotedPrintable(input: string): string {
  const joined = input.replace(/=(?:\r\n|\n)/g, '')
  const bytes: number[] = []
  for (let index = 0; index < joined.length; index += 1) {
    const char = joined[index] as string
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(joined.slice(index + 1, index + 3), 16))
      index += 2
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) {
      bytes.push(code)
      continue
    }
    // Keep multi-byte characters intact by round-tripping through UTF-8.
    for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte)
  }
  return Buffer.from(bytes).toString('utf8')
}
