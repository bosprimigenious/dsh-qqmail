/**
 * dsh-qqmail — MIME/value shaping helpers.
 *
 * Pure functions only: address normalization, size and date formatting, HTML
 * fallback stripping and the search-window heuristics. Both the mail core and
 * its tests import this module, so nothing here may touch the network or the
 * filesystem.
 */

import type { MessageAddress } from './types.ts'

/** Anything mailparser hands us for an address field. */
export interface RawAddress {
  name?: string
  address?: string
}

/** Normalize one mailparser address object. */
export function toAddress(raw: RawAddress | undefined): MessageAddress {
  return { name: (raw?.name ?? '').trim(), address: (raw?.address ?? '').trim() }
}

/**
 * Normalize a mailparser address field.
 * @param value - an array of address objects, a single object, or undefined.
 */
export function toAddressList(value: unknown): MessageAddress[] {
  if (value === undefined || value === null) return []
  const items = Array.isArray(value) ? value : [value]
  const out: MessageAddress[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    // AddressObject carries the real list under `value`; a bare address object
    // has `address` directly.
    const nested = (item as { value?: unknown }).value
    if (Array.isArray(nested)) {
      for (const entry of nested) out.push(toAddress(entry as RawAddress))
      continue
    }
    out.push(toAddress(item as RawAddress))
  }
  return out.filter((entry) => entry.address !== '' || entry.name !== '')
}

/** Render one address as `Name <addr>` (or just the bare address). */
export function formatAddress(value: MessageAddress): string {
  if (value.name === '') return value.address
  return value.name + ' <' + value.address + '>'
}

/** Render an address list as a comma-separated header value. */
export function formatAddressList(list: readonly MessageAddress[]): string {
  return list.map(formatAddress).join(', ')
}

/** Render a compact one-line sender label for lists. */
export function senderLabel(list: readonly MessageAddress[]): string {
  const first = list[0]
  if (first === undefined) return '(unknown sender)'
  const rest = list.length > 1 ? ' 等 ' + String(list.length) + ' 人' : ''
  return (first.name !== '' ? first.name : first.address) + rest
}

/** Human-readable byte size. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return String(Math.round(bytes)) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

/** Truncate a string on a word-ish boundary, appending an ellipsis. */
export function truncate(value: string, max: number): string {
  const text = value.trim()
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/**
 * Collapse a body into a one-line preview.
 * @param value - the plain-text body.
 * @param max - maximum preview length.
 */
export function preview(value: string, max = 140): string {
  const flat = value
    .replace(/^[ \t]*>.*$/gm, '') // drop quoted reply lines
    .replace(/\s+/g, ' ')
    .trim()
  return truncate(flat, max)
}

/** Strip tags and decode the handful of entities that matter, as a last resort. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** True when the string contains characters outside printable ASCII. */
export function hasNonAscii(value: string): boolean {
  return /[^\x20-\x7e]/.test(value)
}

/**
 * Parse a user/model supplied date.
 *
 * Accepts `YYYY-MM-DD`, `YYYY/MM/DD`, a full ISO timestamp, or anything `Date`
 * understands. A date-only value is interpreted as local midnight, which is what
 * a user means by "since 2026-09-01".
 * @returns the Date, or undefined when the input is not a usable date.
 */
export function parseDate(value: string): Date | undefined {
  const text = value.trim()
  if (text === '') return undefined
  const dateOnly = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text)
  if (dateOnly !== null) {
    const year = Number(dateOnly[1])
    const month = Number(dateOnly[2])
    const day = Number(dateOnly[3])
    const date = new Date(year, month - 1, day, 0, 0, 0, 0)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

/** ISO timestamp for a Date, or '' when absent/invalid. */
export function isoDate(value: Date | undefined): string {
  if (value === undefined) return ''
  const time = value.getTime()
  return Number.isNaN(time) ? '' : value.toISOString()
}

/** Local `YYYY-MM-DD HH:mm` rendering (what a human wants to read). */
export function localDateTime(value: Date | undefined): string {
  if (value === undefined || Number.isNaN(value.getTime())) return ''
  const pad = (input: number): string => String(input).padStart(2, '0')
  return (
    String(value.getFullYear()) +
    '-' +
    pad(value.getMonth() + 1) +
    '-' +
    pad(value.getDate()) +
    ' ' +
    pad(value.getHours()) +
    ':' +
    pad(value.getMinutes())
  )
}

/** Leaf name of an IMAP path (`INBOX/Sub` → `Sub`, `INBOX` → `INBOX`). */
export function folderLeaf(path: string): string {
  const parts = path.split(/[/.]/)
  return parts[parts.length - 1] ?? path
}

/** Append a signature to a plain-text body with exactly one blank line. */
export function appendSignature(body: string, signature: string): string {
  const text = body.replace(/\s+$/, '')
  const mark = signature.trim()
  if (mark === '') return text
  return text === '' ? mark : text + '\n\n' + mark
}

/** Strip CR/LF out of a header-bound value (header injection guard). */
export function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

/** Split a comma/semicolon separated address list, ignoring empties. */
export function splitAddresses(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** Guard a relative path against escaping its root. */
export function safeFilename(value: string, fallback = 'attachment'): string {
  const base = value.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return fallback
  return cleaned.slice(0, 180)
}
