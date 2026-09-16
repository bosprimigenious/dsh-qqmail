/**
 * dsh-qqmail — provider presets.
 *
 * Endpoint defaults and the exact credential story for each provider. The one
 * that matters most is QQ Mail: it rejects the account password outright and
 * requires a 16-character authorization code generated after enabling the
 * IMAP/SMTP service, which is why this plugin does not need OAuth at all.
 */

import type { PresetId, ServerSettings } from './types.ts'

/** One provider's defaults. */
export interface Preset {
  id: PresetId
  /** Shown in the settings panel and in config results. */
  label: string
  imap: ServerSettings
  smtp: ServerSettings
  /** How to obtain the credential this provider wants. */
  credentialHint: string
}

/** Every supported provider. `custom` has no defaults on purpose. */
export const PRESETS: Record<PresetId, Preset> = {
  qq: {
    id: 'qq',
    label: 'QQ 邮箱（@qq.com）',
    imap: { host: 'imap.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true },
    credentialHint:
      '登录 QQ 邮箱网页版 → 设置 → 账号 → 开启「IMAP/SMTP服务」→ 按提示验证后生成 16 位授权码，把授权码填进 authCode（不是 QQ 密码）。',
  },
  'qq-exmail': {
    id: 'qq-exmail',
    label: '腾讯企业邮箱（exmail）',
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
    credentialHint:
      '在腾讯企业邮箱网页版「设置 → 邮箱绑定/客户端设置」开启 IMAP/SMTP 并生成客户端专用密码，填入 authCode。',
  },
  163: {
    id: '163',
    label: '网易 163 邮箱',
    imap: { host: 'imap.163.com', port: 993, secure: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true },
    credentialHint: '在 163 邮箱网页版「设置 → POP3/SMTP/IMAP」开启服务并获取授权码，填入 authCode。',
  },
  126: {
    id: '126',
    label: '网易 126 邮箱',
    imap: { host: 'imap.126.com', port: 993, secure: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true },
    credentialHint: '在 126 邮箱网页版「设置 → POP3/SMTP/IMAP」开启服务并获取授权码，填入 authCode。',
  },
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    credentialHint:
      'Gmail 不接受账号密码：需先开启两步验证，再创建 16 位「应用专用密码」，填入 authCode（国内网络通常需要代理）。',
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    credentialHint:
      'Outlook 的 SMTP 用 587 + STARTTLS；若账号开了两步验证，需创建应用密码填入 authCode。',
  },
  custom: {
    id: 'custom',
    label: '自定义 IMAP/SMTP',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    credentialHint: '自行填写 imapHost/imapPort/imapSecure 与 smtpHost/smtpPort/smtpSecure。',
  },
}

/** Provider domains we can infer from the address alone. */
const DOMAIN_PRESETS: readonly { pattern: RegExp; preset: PresetId }[] = [
  { pattern: /@(qq|foxmail)\.com$/i, preset: 'qq' },
  { pattern: /@exmail\.qq\.com$/i, preset: 'qq-exmail' },
  { pattern: /@163\.com$/i, preset: '163' },
  { pattern: /@126\.com$/i, preset: '126' },
  { pattern: /@gmail\.com$/i, preset: 'gmail' },
  { pattern: /@(outlook|hotmail|live)\.(com|cn)$/i, preset: 'outlook' },
]

/**
 * Infer a preset from an address.
 * @param email - the mailbox address.
 * @returns the matching preset, else 'custom' (enterprise domains are not guessable).
 */
export function detectPreset(email: string): PresetId {
  const address = email.trim()
  for (const entry of DOMAIN_PRESETS) {
    if (entry.pattern.test(address)) return entry.preset
  }
  return 'custom'
}

/** All preset ids, in a stable order for the settings panel. */
export const PRESET_IDS: readonly PresetId[] = [
  'qq',
  'qq-exmail',
  '163',
  '126',
  'gmail',
  'outlook',
  'custom',
]
