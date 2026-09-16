/**
 * dsh-qqmail panel — the visible entry for the mailbox plugin.
 *
 * Rendered as a settings-page section (`settings.section` slot). It shows the
 * account state, drives configuration (provider preset, address, authorization
 * code, behaviour switches), runs a real connect-and-authenticate probe, and
 * offers an inbox quick-look plus a small compose box.
 *
 * Plain React, inline styles only, theme-agnostic (colours inherit where
 * possible so light/dark both work), no emoji — single-colour inline SVG for the
 * few icons.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  QqmailApi,
  addressLabel,
  formatDate,
  formatSize,
  type MailboxInfo,
  type MessageDetail,
  type MessageSummary,
  type PresetInfo,
  type ToolPayload,
} from './api.ts'

/** Module-level API client (stateless; the component closes over it). */
const api = new QqmailApi()

/** Mailbox blue — used only for identity and primary actions. */
const ACCENT = '#1E80FF'

/** One shared style sheet (tiny and theme-agnostic). */
const s: Record<string, React.CSSProperties> = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    maxWidth: '680px',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid rgba(128,128,128,0.3)',
    fontSize: '13px',
    color: 'inherit',
    boxSizing: 'border-box',
  },
  head: { display: 'flex', alignItems: 'center', gap: '8px' },
  dot: { width: 8, height: 8, borderRadius: '50%', flex: 'none', background: '#c9cdd4' },
  title: { fontWeight: 600, fontSize: '13px', margin: 0, flex: 1 },
  badge: {
    fontSize: '11px',
    padding: '1px 7px',
    borderRadius: '999px',
    border: '1px solid rgba(128,128,128,0.35)',
    opacity: 0.85,
    whiteSpace: 'nowrap',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    paddingTop: '10px',
    borderTop: '1px solid rgba(128,128,128,0.22)',
  },
  sectionTitle: { fontSize: '12px', fontWeight: 600, opacity: 0.9, margin: 0 },
  row: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
  label: { fontSize: '12px', opacity: 0.85, minWidth: '84px' },
  input: {
    flex: 1,
    minWidth: '140px',
    boxSizing: 'border-box',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
  },
  select: {
    flex: 1,
    minWidth: '140px',
    boxSizing: 'border-box',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
  },
  textarea: {
    width: '100%',
    minHeight: '96px',
    boxSizing: 'border-box',
    padding: '7px 9px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
    fontFamily: 'inherit',
    resize: 'vertical',
  },
  button: {
    padding: '5px 12px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
    cursor: 'pointer',
  },
  primary: {
    padding: '5px 14px',
    borderRadius: '6px',
    border: 'none',
    background: ACCENT,
    color: '#fff',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  hint: { fontSize: '11px', opacity: 0.7, lineHeight: 1.55, margin: 0 },
  ok: { fontSize: '12px', color: '#1f9254', margin: 0, lineHeight: 1.55 },
  bad: { fontSize: '12px', color: '#d03050', margin: 0, lineHeight: 1.55 },
  list: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '260px',
    overflowY: 'auto',
    border: '1px solid rgba(128,128,128,0.26)',
    borderRadius: '8px',
  },
  item: {
    display: 'flex',
    gap: '8px',
    alignItems: 'baseline',
    padding: '6px 9px',
    borderBottom: '1px solid rgba(128,128,128,0.16)',
    cursor: 'pointer',
    textAlign: 'left',
    background: 'transparent',
    color: 'inherit',
    border: 'none',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'rgba(128,128,128,0.16)',
    font: 'inherit',
    width: '100%',
  },
  itemWho: { fontSize: '12px', fontWeight: 600, flex: 'none', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  itemSubject: { fontSize: '12px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.92 },
  itemDate: { fontSize: '11px', opacity: 0.6, flex: 'none', whiteSpace: 'nowrap' },
  unread: { width: 6, height: 6, borderRadius: '50%', background: ACCENT, flex: 'none' },
  read: { width: 6, height: 6, borderRadius: '50%', background: 'transparent', flex: 'none' },
  body: {
    maxHeight: '320px',
    overflowY: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: '12px',
    lineHeight: 1.6,
    padding: '10px 12px',
    borderRadius: '8px',
    background: 'rgba(128,128,128,0.07)',
  },
  meta: { fontSize: '11px', opacity: 0.75, margin: 0, lineHeight: 1.6 },
  check: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' },
}

/** A tiny inline SVG icon (no emoji, single colour). */
function Icon({ kind }: { kind: 'refresh' | 'mail' | 'check' | 'send' }): React.ReactElement {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  if (kind === 'refresh') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-3-6.7" />
        <path d="M21 3v6h-6" />
      </svg>
    )
  }
  if (kind === 'send') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M22 2 11 13" />
        <path d="M22 2 15 22l-4-9-9-4Z" />
      </svg>
    )
  }
  if (kind === 'check') {
    return (
      <svg {...common} aria-hidden="true">
        <path d="m20 6-11 11-5-5" />
      </svg>
    )
  }
  return (
    <svg {...common} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  )
}

/** Panel props (the settings slot renders it with no props). */
export interface QqmailPanelProps {
  variant?: string
  onClose?: () => void
}

/** The settings-page section. */
export function QqmailPanel(_props: QqmailPanelProps): React.ReactElement {
  const [ready, setReady] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [readOnly, setReadOnly] = useState(true)
  const [presets, setPresets] = useState<PresetInfo[]>([])
  const [probeText, setProbeText] = useState('')
  const [probeOk, setProbeOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  // Draft config fields (only non-empty drafts are submitted).
  const [preset, setPreset] = useState('qq')
  const [email, setEmail] = useState('')
  const [authCode, setAuthCode] = useState('')
  const [authHint, setAuthHint] = useState('')
  const [credentialHint, setCredentialHint] = useState('')
  const [fromName, setFromName] = useState('')
  const [signature, setSignature] = useState('')
  const [downloadDir, setDownloadDir] = useState('')
  const [previewInList, setPreviewInList] = useState(false)
  const [saveSent, setSaveSent] = useState(true)
  const [configPath, setConfigPath] = useState('')

  // Inbox state.
  const [mailboxes, setMailboxes] = useState<MailboxInfo[]>([])
  const [mailbox, setMailbox] = useState('INBOX')
  const [unseenOnly, setUnseenOnly] = useState(false)
  const [items, setItems] = useState<MessageSummary[]>([])
  const [detail, setDetail] = useState<MessageDetail | null>(null)
  const [listNote, setListNote] = useState('')

  // Compose state.
  const [composeOpen, setComposeOpen] = useState(false)
  const [sendTo, setSendTo] = useState('')
  const [sendSubject, setSendSubject] = useState('')
  const [sendText, setSendText] = useState('')

  const bootstrapped = useRef(false)

  /** Load status and refresh the drafts. */
  const loadStatus = useCallback(async (probe = false): Promise<void> => {
    try {
      const response = probe ? await api.probe() : await api.status()
      const status = probe ? await api.status() : response
      const view = (status as { data?: Record<string, unknown> }).data
      if (view === undefined) return
      setConfigured(view.configured === true)
      setReadOnly(view.readOnly === true)
      setPresets((status as { presets?: PresetInfo[] }).presets ?? [])
      setPreset(typeof view.preset === 'string' ? view.preset : 'qq')
      setEmail(typeof view.email === 'string' ? view.email : '')
      setAuthHint(typeof view.authCodeHint === 'string' ? view.authCodeHint : '')
      setCredentialHint(typeof view.credentialHint === 'string' ? view.credentialHint : '')
      setFromName(typeof view.fromName === 'string' ? view.fromName : '')
      setSignature(typeof view.signature === 'string' ? view.signature : '')
      setDownloadDir(typeof view.downloadDir === 'string' ? view.downloadDir : '')
      setPreviewInList(view.previewInList === true)
      setSaveSent(view.saveSent !== false)
      setConfigPath(typeof view.configPath === 'string' ? view.configPath : '')
      setReady(true)
      if (probe) {
        const result = (status as { data?: { probe?: Record<string, unknown> } }).data?.probe
        if (result !== undefined) {
          setProbeOk(result.ok === true)
          setProbeText(
            'IMAP ' +
              (result.imapOk === true ? '通过' + (result.mailboxCount !== undefined ? '（' + String(result.mailboxCount) + ' 个文件夹）' : '') : '失败：' + String(result.imapError ?? '')) +
              '　SMTP ' +
              (result.smtpOk === true ? '通过' : '失败：' + String(result.smtpError ?? '')),
          )
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void loadStatus(false)
  }, [loadStatus])

  /** Persist the configuration drafts. */
  const save = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const patch: Record<string, unknown> = {
        preset,
        email,
        fromName,
        signature,
        downloadDir,
        readOnly,
        previewInList,
        saveSent,
      }
      // An empty box means "leave the stored code alone" — the host never sends
      // the secret back to the browser, so the field always starts empty.
      if (authCode.trim() !== '') patch.authCode = authCode.trim()
      const response = await api.setConfig(patch)
      setAuthCode('')
      setMessage(response.ok ? '配置已保存。' : response.message)
      await loadStatus(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [authCode, downloadDir, email, fromName, loadStatus, preset, previewInList, readOnly, saveSent, signature])

  /** Run the real connect check. */
  const runProbe = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    setProbeText('')
    try {
      await loadStatus(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [loadStatus])

  /** Load folders and the current page of messages. */
  const loadInbox = useCallback(
    async (targetMailbox = mailbox, unseen = unseenOnly): Promise<void> => {
      setBusy(true)
      setError('')
      setDetail(null)
      try {
        const folders = await api.folders()
        const list = (folders.data?.mailboxes ?? []) as MailboxInfo[]
        setMailboxes(list)
        const chosen = list.some((entry) => entry.path === targetMailbox) ? targetMailbox : list[0]?.path ?? 'INBOX'
        setMailbox(chosen)
        const payload: ToolPayload = await api.list({ mailbox: chosen, limit: 25, unseen })
        setItems((payload.data?.items ?? []) as MessageSummary[])
        setListNote(payload.ok ? '' : payload.message)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [mailbox, unseenOnly],
  )

  /** Open one message. */
  const openMessage = useCallback(
    async (uid: number): Promise<void> => {
      setBusy(true)
      setError('')
      try {
        const payload = await api.read(uid, mailbox)
        const first = (payload.data?.items ?? [])[0] as MessageDetail | undefined
        if (first !== undefined) setDetail(first)
        else setError(payload.message)
        setItems((current) => current.map((entry) => (entry.uid === uid ? { ...entry, seen: true } : entry)))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [mailbox],
  )

  /** Toggle one flag. */
  const toggleFlag = useCallback(
    async (uid: number, flagged: boolean): Promise<void> => {
      setBusy(true)
      try {
        const response = await api.mark({ uid, mailbox, flagged })
        setMessage(response.message)
        setItems((current) => current.map((entry) => (entry.uid === uid ? { ...entry, flagged } : entry)))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [mailbox],
  )

  /** Send the composed message. */
  const send = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const recipients = sendTo
        .split(/[,;]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      if (recipients.length === 0) throw new Error('请填写收件人。')
      const response = await api.send({ to: recipients, subject: sendSubject, text: sendText })
      setMessage(response.message)
      if (response.ok) {
        setSendTo('')
        setSendSubject('')
        setSendText('')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [sendSubject, sendText, sendTo])

  const statusColor = !configured ? '#c9cdd4' : probeText === '' ? '#f0a020' : probeOk ? '#1f9254' : '#d03050'
  const statusLabel = !configured ? '未配置' : probeText === '' ? '已配置（未自检）' : probeOk ? '连接正常' : '连接异常'

  if (!ready && error === '') {
    return (
      <div style={s.card}>
        <div style={s.head}>
          <span style={{ ...s.dot, background: '#c9cdd4' }} />
          <p style={s.title}>QQ 邮箱</p>
        </div>
        <p style={s.hint}>正在读取状态…</p>
      </div>
    )
  }

  return (
    <div style={s.card}>
      <div style={s.head}>
        <span style={{ ...s.dot, background: statusColor }} />
        <p style={s.title}>QQ 邮箱</p>
        <span style={s.badge}>{statusLabel}</span>
        <span style={s.badge}>{email === '' ? '未设地址' : email}</span>
        <span style={s.badge}>{readOnly ? '只读' : '读写'}</span>
      </div>

      {error !== '' ? <p style={s.bad}>{error}</p> : null}
      {message !== '' ? <p style={s.ok}>{message}</p> : null}
      {probeText !== '' ? <p style={probeOk ? s.ok : s.bad}>{probeText}</p> : null}

      <div style={s.section}>
        <p style={s.sectionTitle}>账户</p>
        <div style={s.row}>
          <span style={s.label}>服务商</span>
          <select
            style={s.select}
            value={preset}
            onChange={(event) => {
              const next = event.target.value
              setPreset(next)
              const found = presets.find((entry) => entry.id === next)
              if (found !== undefined) setCredentialHint(found.credentialHint)
            }}
          >
            {(presets.length > 0 ? presets : [{ id: 'qq', label: 'QQ 邮箱（@qq.com）', credentialHint: '', imap: { host: '', port: 0, secure: true }, smtp: { host: '', port: 0, secure: true } }]).map(
              (entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ),
            )}
          </select>
        </div>
        <div style={s.row}>
          <span style={s.label}>邮箱地址</span>
          <input
            style={s.input}
            value={email}
            placeholder="someone@qq.com"
            spellCheck={false}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div style={s.row}>
          <span style={s.label}>授权码</span>
          <input
            style={s.input}
            type="password"
            value={authCode}
            placeholder={authHint === '' ? '在 QQ 邮箱设置里生成 16 位授权码' : '已配置：' + authHint + '（留空则不修改）'}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setAuthCode(event.target.value)}
          />
        </div>
        <div style={s.row}>
          <span style={s.label}>发件人显示名</span>
          <input style={s.input} value={fromName} placeholder="留空则只显示邮箱地址" onChange={(event) => setFromName(event.target.value)} />
        </div>
        <div style={s.row}>
          <span style={s.label}>签名</span>
          <input style={s.input} value={signature} placeholder="自动附加在发出的邮件末尾" onChange={(event) => setSignature(event.target.value)} />
        </div>
        <div style={s.row}>
          <button style={s.primary} type="button" disabled={busy} onClick={() => void save()}>
            保存配置
          </button>
          <button style={s.button} type="button" disabled={busy || !configured} onClick={() => void runProbe()}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <Icon kind="check" />
              连接自检
            </span>
          </button>
        </div>
        {credentialHint !== '' ? <p style={s.hint}>{credentialHint}</p> : null}
        {configPath !== '' ? <p style={s.hint}>配置文件：{configPath}（权限 0600，含授权码）</p> : null}
      </div>

      <div style={s.section}>
        <p style={s.sectionTitle}>行为</p>
        <label style={s.check}>
          <input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} />
          只读模式（不向 agent 注册发送 / 标记 / 移动 / 删除工具）
        </label>
        <label style={s.check}>
          <input type="checkbox" checked={saveSent} onChange={(event) => setSaveSent(event.target.checked)} />
          发送后存一份到「已发送」
        </label>
        <label style={s.check}>
          <input type="checkbox" checked={previewInList} onChange={(event) => setPreviewInList(event.target.checked)} />
          列表附带正文预览（稍慢）
        </label>
        <div style={s.row}>
          <span style={s.label}>附件目录</span>
          <input
            style={s.input}
            value={downloadDir}
            placeholder="留空则存到 DSH_HOME/dsh-qqmail/attachments"
            spellCheck={false}
            onChange={(event) => setDownloadDir(event.target.value)}
          />
        </div>
      </div>

      <div style={s.section}>
        <p style={s.sectionTitle}>收件箱速览</p>
        <div style={s.row}>
          <select
            style={{ ...s.select, flex: 'none', minWidth: '180px' }}
            value={mailbox}
            onChange={(event) => {
              setMailbox(event.target.value)
              void loadInbox(event.target.value, unseenOnly)
            }}
          >
            {(mailboxes.length > 0 ? mailboxes : [{ path: 'INBOX', name: 'INBOX', specialUse: '', subscribed: true, messages: -1, unseen: -1 }]).map(
              (entry) => (
                <option key={entry.path} value={entry.path}>
                  {entry.path}
                  {entry.unseen > 0 ? '（' + String(entry.unseen) + ' 未读）' : ''}
                </option>
              ),
            )}
          </select>
          <label style={s.check}>
            <input
              type="checkbox"
              checked={unseenOnly}
              onChange={(event) => {
                setUnseenOnly(event.target.checked)
                void loadInbox(mailbox, event.target.checked)
              }}
            />
            只看未读
          </label>
          <button style={s.button} type="button" disabled={busy || !configured} onClick={() => void loadInbox(mailbox, unseenOnly)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <Icon kind="refresh" />
              刷新
            </span>
          </button>
        </div>

        {items.length > 0 ? (
          <div style={s.list}>
            {items.map((entry) => (
              <button
                key={entry.uid}
                type="button"
                style={s.item}
                onClick={() => void openMessage(entry.uid)}
                title={entry.subject}
              >
                <span style={entry.seen ? s.read : s.unread} />
                <span style={s.itemWho}>{addressLabel(entry.from)}</span>
                <span style={s.itemSubject}>
                  {entry.flagged ? '★ ' : ''}
                  {entry.hasAttachments ? '📎 ' : ''}
                  {entry.subject}
                </span>
                <span style={s.itemDate}>{formatDate(entry.date)}</span>
              </button>
            ))}
          </div>
        ) : (
          <p style={s.hint}>{configured ? '点「刷新」加载邮件列表。' : '先填写邮箱地址与授权码并保存，再点刷新。'}</p>
        )}
        {listNote !== '' ? <p style={s.hint}>{listNote}</p> : null}

        {detail !== null ? (
          <div style={s.section}>
            <p style={s.sectionTitle}>
              {detail.subject}
              <button
                type="button"
                style={{ ...s.button, marginLeft: '8px', padding: '2px 8px' }}
                onClick={() => void toggleFlag(detail.uid, !detail.flagged)}
              >
                {detail.flagged ? '取消星标' : '加星标'}
              </button>
            </p>
            <p style={s.meta}>
              {addressLabel(detail.from)} → {addressLabel(detail.to)}　{formatDate(detail.date)}　{formatSize(detail.size)}
            </p>
            {detail.attachments.length > 0 ? (
              <p style={s.meta}>
                附件：{detail.attachments.map((entry) => String(entry.index) + '. ' + entry.filename + '（' + formatSize(entry.size) + '）').join('；')}
                <br />
                （下载走 qqmail_attachment 工具，或让 agent 保存到本地）
              </p>
            ) : null}
            <div style={s.body}>{detail.text === '' ? '(无正文)' : detail.text}</div>
          </div>
        ) : null}
      </div>

      <div style={s.section}>
        <p style={s.sectionTitle}>
          写邮件
          <button type="button" style={{ ...s.button, marginLeft: '8px', padding: '2px 8px' }} onClick={() => setComposeOpen((value) => !value)}>
            {composeOpen ? '收起' : '展开'}
          </button>
          {readOnly ? <span style={{ ...s.hint, marginLeft: '8px' }}>当前只读——面板仍可发送，agent 工具需关闭只读模式</span> : null}
        </p>
        {composeOpen ? (
          <>
            <div style={s.row}>
              <span style={s.label}>收件人</span>
              <input style={s.input} value={sendTo} placeholder="a@b.com, c@d.com" spellCheck={false} onChange={(event) => setSendTo(event.target.value)} />
            </div>
            <div style={s.row}>
              <span style={s.label}>主题</span>
              <input style={s.input} value={sendSubject} onChange={(event) => setSendSubject(event.target.value)} />
            </div>
            <textarea style={s.textarea} value={sendText} placeholder="正文（会自动附加签名）" onChange={(event) => setSendText(event.target.value)} />
            <div style={s.row}>
              <button style={s.primary} type="button" disabled={busy || !configured} onClick={() => void send()}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                  <Icon kind="send" />
                  发送
                </span>
              </button>
              <span style={s.hint}>
                <Icon kind="mail" /> 真实发信，请确认收件人与内容
              </span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

export default QqmailPanel
