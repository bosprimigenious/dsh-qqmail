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
  type AccountView,
  type AccountsView,
  type ConfigView,
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
  head: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
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

interface AccountDraft {
  preset: string; email: string; authCode: string; authHint: string; credentialHint: string
  fromName: string; signature: string; sentFolder: string; downloadDir: string; previewInList: boolean
  saveSent: boolean; configPath: string
}
function draftFrom(view?: ConfigView): AccountDraft {
  return { preset: view?.preset ?? 'qq', email: view?.email ?? '', authCode: '',
    authHint: view?.authCodeHint ?? '', credentialHint: view?.credentialHint ?? '',
    fromName: view?.fromName ?? '', signature: view?.signature ?? '', sentFolder: view?.sentFolder ?? '', downloadDir: view?.downloadDir ?? '',
    previewInList: view?.previewInList ?? false, saveSent: view?.saveSent ?? true, configPath: view?.configPath ?? '' }
}

/** Panel props (the settings slot renders it with no props). */
export interface QqmailPanelProps {
  variant?: string
  onClose?: () => void
}

/** The settings-page section. */
export function QqmailPanel(_props: QqmailPanelProps): React.ReactElement {
  const [ready, setReady] = useState(false)
  const [readOnly, setReadOnly] = useState(true)
  const [presets, setPresets] = useState<PresetInfo[]>([])
  const [probeText, setProbeText] = useState('')
  const [probeOk, setProbeOk] = useState(false)
  const [busy, setBusyState] = useState(false)
  const pending = useRef(0)
  const setBusy = useCallback((starting: boolean): void => {
    pending.current = Math.max(0, pending.current + (starting ? 1 : -1))
    setBusyState(pending.current > 0)
  }, [])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const [accounts, setAccounts] = useState<AccountView[]>([])
  const [resolvedDefaultId, setResolvedDefaultId] = useState('')
  const [listWarning, setListWarning] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [newId, setNewId] = useState('')
  const [removeTarget, setRemoveTarget] = useState('')
  const selectedRef = useRef('')
  const selectionEpoch = useRef(0)
  const [drafts, setDrafts] = useState<Record<string, AccountDraft>>({})
  const draft = drafts[selectedId] ?? draftFrom()
  const { preset, email, authCode, authHint, credentialHint, fromName, signature, sentFolder, downloadDir, previewInList, saveSent, configPath } = draft
  const configured = accounts.find((a) => a.id === selectedId)?.configured ?? false
  const setField = <K extends keyof AccountDraft>(key: K, value: AccountDraft[K]): void => {
    setDrafts((current) => ({ ...current, [selectedId]: { ...(current[selectedId] ?? draftFrom()), [key]: value } }))
  }
  const setPreset = (value: string): void => setField('preset', value)
  const setEmail = (value: string): void => setField('email', value)
  const setAuthCode = (value: string): void => setField('authCode', value)
  const setCredentialHint = (value: string): void => setField('credentialHint', value)
  const setFromName = (value: string): void => setField('fromName', value)
  const setSignature = (value: string): void => setField('signature', value)
  const setSentFolder = (value: string): void => setField('sentFolder', value)
  const setDownloadDir = (value: string): void => setField('downloadDir', value)
  const setPreviewInList = (value: boolean): void => setField('previewInList', value)
  const setSaveSent = (value: boolean): void => setField('saveSent', value)

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
  const selectAccount = useCallback((id: string): void => {
    selectedRef.current = id
    selectionEpoch.current += 1
    setSelectedId(id)
    setRemoveTarget('')
    setMailboxes([]); setMailbox('INBOX'); setUnseenOnly(false); setItems([]); setDetail(null); setListNote('')
    setProbeText(''); setProbeOk(false); setError(''); setMessage('')
    // A compose draft must never silently change its sending identity.
    setComposeOpen(false); setSendTo(''); setSendSubject(''); setSendText('')
  }, [])

  const applyAccounts = useCallback((data: AccountsView, preferredId?: string): void => {
    setAccounts(data.accounts); setResolvedDefaultId(data.resolvedDefaultAccount); setListWarning(data.warning)
    setDrafts((current) => {
      const next: Record<string, AccountDraft> = {}
      // Keep the unsaved creation form, while discarding deleted account secrets.
      if (current.__new__) next.__new__ = current.__new__
      for (const account of data.accounts) next[account.id] = current[account.id] ?? draftFrom(account)
      return next
    })
    const desired = preferredId ?? selectedRef.current
    if (data.accounts.some((a) => a.id === desired)) {
      if (desired !== selectedRef.current) selectAccount(desired)
    } else selectAccount(data.resolvedDefaultAccount || '__new__')
  }, [selectAccount])

  const loadAccounts = useCallback(async (preferredId?: string): Promise<void> => {
    const response = await api.accounts()
    if (!response.ok) throw new Error(response.message)
    applyAccounts(response.data, preferredId)
  }, [applyAccounts])

  const loadAccountView = useCallback(async (id: string): Promise<void> => {
    const epoch = selectionEpoch.current
    setBusy(true)
    try {
      const response = await api.status(false, id === '__new__' ? undefined : id)
      if (epoch !== selectionEpoch.current) return
      if (!response.ok) throw new Error(response.message)
      const view = response.data
      const actualId = view.account?.id ?? id
      if (actualId !== id && id !== '__new__') throw new Error('账号身份不匹配，请刷新账号列表。')
      setPresets(response.presets); setReadOnly(response.readOnly)
      setDrafts((current) => ({ ...current, [id]: current[id] ?? draftFrom(id === '__new__' ? undefined : view) }))
      setReady(true)
    } catch (cause) {
      if (epoch === selectionEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void loadAccounts().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [loadAccounts])
  useEffect(() => { if (selectedId) void loadAccountView(selectedId) }, [selectedId, loadAccountView])

  /** Persist the configuration drafts. */
  const save = useCallback(async (): Promise<void> => {
    const epoch = selectionEpoch.current
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const patch: Record<string, unknown> = {
        preset,
        email,
        fromName,
        signature,
        sentFolder,
        downloadDir,
        previewInList,
        saveSent,
      }
      // An empty box means "leave the stored code alone" — the host never sends
      // the secret back to the browser, so the field always starts empty.
      if (authCode.trim() !== '') patch.authCode = authCode.trim()
      const id = selectedId
      const creating = id === '__new__'
      if (creating && (!email.trim() || !authCode.trim())) throw new Error('新增账号必须填写邮箱地址和授权码。')
      if (creating && newId.trim()) patch.id = newId.trim()
      const response = creating
        ? await api.accountsAction({ ...patch, action: 'add' })
        : await api.setConfig(patch, id)
      if (epoch !== selectionEpoch.current) return
      if (!response.ok) throw new Error(response.message)
      setDrafts((current) => ({ ...current, [id]: { ...current[id]!, authCode: current[id]?.authCode === authCode ? '' : current[id]?.authCode ?? '', authHint: response.data?.authCodeHint ?? current[id]?.authHint ?? '', credentialHint: response.data?.credentialHint ?? current[id]?.credentialHint ?? '', configPath: response.data?.configPath ?? current[id]?.configPath ?? '' } }))
      if (creating) {
        // Add returns ConfigView, not AccountsView. Refresh to resolve an auto-derived id.
        const refreshed = await api.accounts()
        if (epoch !== selectionEpoch.current) return
        if (!refreshed.ok) throw new Error(refreshed.message)
        const createdId = response.data?.account?.id ?? refreshed.data.accounts.find((account) => account.email.toLowerCase() === email.trim().toLowerCase())?.id
        if (!createdId) throw new Error('账号已创建，请刷新账号列表。')
        setDrafts((current) => { const next = { ...current }; delete next.__new__; return next })
        setNewId('')
        applyAccounts(refreshed.data, createdId)
        setMessage('账号已创建。')
      } else {
        await loadAccounts()
        if (epoch === selectionEpoch.current) setMessage('配置已保存。')
      }
    } catch (cause) {
      if (epoch === selectionEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [authCode, downloadDir, email, fromName, loadAccounts, applyAccounts, newId, selectedId, preset, previewInList, saveSent, signature, sentFolder])

  const manageAccount = async (action: 'setDefault' | 'remove'): Promise<void> => {
    const id = selectedId
    const epoch = selectionEpoch.current
    if (id === '__new__' || !id || (action === 'remove' && removeTarget !== id)) return
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await api.accountsAction({ action, account: id, ...(action === 'remove' ? { confirm: true } : {}) })
      if (epoch !== selectionEpoch.current) return
      if (!response.ok) throw new Error(response.message)
      applyAccounts(response.data)
      setRemoveTarget('')
      setMessage(action === 'remove' ? '账号已删除，本地邮件文件未删除。' : '默认账号已更新。')
    } catch (cause) {
      if (epoch === selectionEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }

  /** Run the real connect check. */
  const runProbe = useCallback(async (): Promise<void> => {
    const epoch = selectionEpoch.current
    setBusy(true)
    setError('')
    setProbeText('')
    try {
      const response = await api.probe(selectedId)
      if (epoch !== selectionEpoch.current) return
      if (!response.ok) throw new Error(response.message)
      const result = response.data?.probe
      setProbeOk(result?.ok === true)
      setProbeText(result ? 'IMAP ' + (result.imapOk ? '通过' : '失败：' + result.imapError) + '；SMTP ' + (result.smtpOk ? '通过' : '失败：' + result.smtpError) : response.message)
    } catch (cause) {
      if (epoch === selectionEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [selectedId])

  const saveReadOnly = async (next: boolean): Promise<void> => {
    setBusy(true); setError('')
    try {
      const response = await api.setConfig({ readOnly: next })
      if (!response.ok) throw new Error(response.message)
      setReadOnly(next); setMessage('插件设置已保存，重启 dsh web 后工具注册生效。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  /** Load folders and the current page of messages. */
  const loadInbox = useCallback(
    async (targetMailbox = mailbox, unseen = unseenOnly): Promise<void> => {
      const epoch = selectionEpoch.current
      setBusy(true)
      setError('')
      setDetail(null)
      try {
        const folders = await api.folders(selectedId)
        if (epoch !== selectionEpoch.current) return
        if (!folders.ok) throw new Error(folders.message)
        const list = (folders.data?.mailboxes ?? []) as MailboxInfo[]
        setMailboxes(list)
        const chosen = list.some((entry) => entry.path === targetMailbox) ? targetMailbox : list[0]?.path ?? 'INBOX'
        setMailbox(chosen)
        const payload: ToolPayload = await api.list({ mailbox: chosen, limit: 25, unseen, account: selectedId })
        if (epoch !== selectionEpoch.current) return
        setItems((payload.data?.items ?? []) as MessageSummary[])
        setListNote(payload.ok ? '' : payload.message)
      } catch (cause) {
        if (epoch === selectionEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [mailbox, unseenOnly, selectedId],
  )

  const lastInboxAccount = useRef('')
  useEffect(() => {
    const previous = lastInboxAccount.current
    lastInboxAccount.current = selectedId
    // Preserve the legacy single-account first-open path (explicit refresh).
    if (configured && (accounts.length > 1 || (previous && previous !== '__new__' && previous !== selectedId))) void loadInbox('INBOX', false)
  }, [selectedId, configured, accounts.length])

  /** Open one message. */
  const openMessage = useCallback(
    async (uid: number): Promise<void> => {
      const epoch = selectionEpoch.current
      setBusy(true)
      setError('')
      try {
        const payload = await api.read(uid, mailbox, selectedId)
      if (epoch !== selectionEpoch.current) return
        const first = (payload.data?.items ?? [])[0] as MessageDetail | undefined
        if (first !== undefined) setDetail(first)
        else setError(payload.message)
        setItems((current) => current.map((entry) => (entry.uid === uid ? { ...entry, seen: true } : entry)))
      } catch (cause) {
        if (epoch === selectionEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [mailbox, selectedId],
  )

  /** Toggle one flag. */
  const toggleFlag = useCallback(
    async (uid: number, flagged: boolean): Promise<void> => {
      const epoch = selectionEpoch.current
      setBusy(true)
      try {
        const response = await api.mark({ uid, mailbox, flagged, account: selectedId })
      if (epoch !== selectionEpoch.current) return
        setMessage(response.message)
        setItems((current) => current.map((entry) => (entry.uid === uid ? { ...entry, flagged } : entry)))
      } catch (cause) {
        if (epoch === selectionEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [mailbox, selectedId],
  )

  /** Send the composed message. */
  const send = useCallback(async (): Promise<void> => {
    const epoch = selectionEpoch.current
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const recipients = sendTo
        .split(/[,;]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
      if (recipients.length === 0) throw new Error('请填写收件人。')
      const response = await api.send({ to: recipients, subject: sendSubject, text: sendText, account: selectedId })
      if (epoch !== selectionEpoch.current) return
      setMessage(response.message)
      if (response.ok) {
        setSendTo('')
        setSendSubject('')
        setSendText('')
      }
    } catch (cause) {
      if (epoch === selectionEpoch.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [sendSubject, sendText, sendTo, selectedId])

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

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
        {accounts.length > 1 ? <aside aria-label="邮箱账号" style={{ flex: '0 0 150px', minWidth: 0 }}>
          <p style={s.sectionTitle}>账号</p>
          {listWarning ? <p role="status" style={{ ...s.hint, color: '#b7791f' }}>{listWarning}</p> : null}
          {accounts.map((account) => (
            <button key={account.id} type="button" disabled={busy} aria-pressed={selectedId === account.id}
              onClick={() => selectAccount(account.id)}
              style={{ ...s.item, display: 'block', overflowWrap: 'anywhere', background: selectedId === account.id ? 'rgba(30,128,255,0.12)' : 'transparent' }}>
              {account.label || account.email || account.id}
              {account.id === resolvedDefaultId ? <span style={s.badge}>默认</span> : null}
            </button>
          ))}
          <button type="button" style={{ ...s.button, marginTop: 8 }} disabled={busy} onClick={() => selectAccount('__new__')}>新增账号</button>
        </aside> : null}
        {accounts.length <= 1 ? <div style={{ width: '100%' }}><button type="button" style={s.button} disabled={busy || selectedId === '__new__'} onClick={() => selectAccount('__new__')}>新增账号</button>{accounts.length === 1 && selectedId === '__new__' ? <button type="button" style={{ ...s.button, marginLeft: 8 }} disabled={busy} onClick={() => selectAccount(accounts[0]!.id)}>返回已绑定账号</button> : null}</div> : null}
        {accounts.length <= 1 && listWarning ? <p role="status" style={{ ...s.hint, color: '#b7791f' }}>{listWarning}</p> : null}
        <fieldset disabled={busy} style={{ flex: '1 1 300px', minWidth: 0, border: 0, margin: 0, padding: 0 }}>
      <div style={s.section}>
        <p style={s.sectionTitle}>账户{selectedId && selectedId !== '__new__' ? '：' + selectedId : '：首次绑定'}</p>
        {selectedId === '__new__' ? <div style={s.row}><span style={s.label}>账号 ID（可选）</span><input style={s.input} value={newId} placeholder="留空则从邮箱地址自动生成" spellCheck={false} onChange={(event) => setNewId(event.target.value)} /></div> : null}
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
          <textarea style={{ ...s.textarea, minHeight: 64, flex: 1, width: 'auto', minWidth: 140 }} value={signature} placeholder="自动附加在发出的邮件末尾" onChange={(event) => setSignature(event.target.value)} />
        </div>
        <div style={s.row}>
          <button style={s.primary} type="button" disabled={busy || !selectedId || (selectedId === '__new__' && (!email.trim() || !authCode.trim()))} onClick={() => void save()}>
            {selectedId === '__new__' ? '创建账号' : '保存配置'}
          </button>
          <button style={s.button} type="button" disabled={busy || !configured} onClick={() => void runProbe()}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <Icon kind="check" />
              连接自检
            </span>
          </button>
        </div>
        {selectedId === '__new__' ? <p style={s.hint}>邮箱地址和授权码均为必填；其他账号的未保存草稿会保留。</p> : <div style={s.row}>
          <button type="button" style={s.button} disabled={busy || selectedId === resolvedDefaultId} onClick={() => void manageAccount('setDefault')}>{selectedId === resolvedDefaultId ? '当前默认账号' : '设为默认'}</button>
          <button type="button" style={s.button} disabled={busy} onClick={() => setRemoveTarget(selectedId)}>删除账号</button>
        </div>}
        {removeTarget === selectedId && selectedId !== '__new__' ? <div role="alert" style={{ ...s.section, borderColor: '#d03050' }}>
          <p style={s.bad}>确定移除 {accounts.find((account) => account.id === selectedId)?.email || selectedId}？将移除该账号配置和授权码，其他账号不受影响。</p>
          <div style={s.row}><button type="button" style={{ ...s.button, color: '#d03050' }} disabled={busy} onClick={() => void manageAccount('remove')}>确认删除账号</button><button type="button" style={s.button} disabled={busy} onClick={() => setRemoveTarget('')}>取消</button></div>
        </div> : null}
        {credentialHint !== '' ? <p style={s.hint}>{credentialHint}</p> : null}
        {configPath !== '' ? <p style={s.hint}>配置文件：{configPath}（权限 0600，含授权码）</p> : null}
      </div>

      <div style={s.section}>
        <p style={s.sectionTitle}>当前账号行为</p>
        <label style={s.check}>
          <input type="checkbox" checked={saveSent} onChange={(event) => setSaveSent(event.target.checked)} />
          发送后存一份到「已发送」
        </label>
        <label style={s.check}>
          <input type="checkbox" checked={previewInList} onChange={(event) => setPreviewInList(event.target.checked)} />
          列表附带正文预览（稍慢）
        </label>
        <div style={s.row}>
          <span style={s.label}>已发送文件夹</span>
          <input style={s.input} value={sentFolder} placeholder="留空则自动探测" spellCheck={false} onChange={(event) => setSentFolder(event.target.value)} />
        </div>
        <div style={s.row}>
          <span style={s.label}>附件目录</span>
          <input
            style={s.input}
            value={downloadDir}
            placeholder={accounts.length > 1 ? '留空则按账号存到 attachments/' + selectedId : '留空则存到 DSH_HOME/dsh-qqmail/attachments'}
            spellCheck={false}
            onChange={(event) => setDownloadDir(event.target.value)}
          />
        </div>
      </div>

        </fieldset>
      </div>
      <div style={s.section}>
        <p style={s.sectionTitle}>插件级设置（对所有账号生效）</p>
        <label style={s.check}>
          <input type="checkbox" disabled={busy} checked={readOnly} onChange={(event) => void saveReadOnly(event.target.checked)} />
          只读模式（重启 dsh web 后工具注册生效）
        </label>
      </div>
      <div style={s.section}>
        <p style={s.sectionTitle}>收件箱速览</p>
        <div style={s.row}>
          <select
            style={{ ...s.select, flex: 'none', minWidth: '180px' }}
            value={mailbox}
            disabled={busy}
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
              disabled={busy}
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
                disabled={busy} onClick={() => void openMessage(entry.uid)}
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
                disabled={busy} onClick={() => void toggleFlag(detail.uid, !detail.flagged)}
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
          写邮件{selectedId !== '__new__' ? '：' + (accounts.find((account) => account.id === selectedId)?.email || selectedId) : ''}
          <button type="button" disabled={busy || !configured} style={{ ...s.button, marginLeft: '8px', padding: '2px 8px' }} onClick={() => setComposeOpen((value) => !value)}>
            {composeOpen ? '收起' : '展开'}
          </button>
          {readOnly ? <span style={{ ...s.hint, marginLeft: '8px' }}>当前只读——面板仍可发送，agent 工具需关闭只读模式</span> : null}
        </p>
        {composeOpen ? (
          <>
            <div style={s.row}>
              <span style={s.label}>收件人</span>
              <input style={s.input} disabled={busy} value={sendTo} placeholder="a@b.com, c@d.com" spellCheck={false} onChange={(event) => setSendTo(event.target.value)} />
            </div>
            <div style={s.row}>
              <span style={s.label}>主题</span>
              <input style={s.input} disabled={busy} value={sendSubject} onChange={(event) => setSendSubject(event.target.value)} />
            </div>
            <textarea style={s.textarea} disabled={busy} value={sendText} placeholder="正文（会自动附加签名）" onChange={(event) => setSendText(event.target.value)} />
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
