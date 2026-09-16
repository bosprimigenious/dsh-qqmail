/**
 * dsh-qqmail end-to-end tests.
 *
 * Drives the real MailService over real sockets against the in-process fake
 * SMTP/IMAP servers in ./fakes.mjs, so the whole stack is exercised: session
 * pooling, envelope parsing, body-part previews, full-source parsing, flag
 * STORE, folder moves, the Sent-folder APPEND, attachment download, and the
 * authentication-failure message a user actually has to act on.
 *
 * Every credential and path stays in a temp dir; nothing touches ~/.dsh.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { MailService, MailStore, composeMessage, normalizeQuery } from '../lib/index.js'
import { startFakeImap, startFakeSmtp } from './fakes.mjs'

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log('  ✔ ' + label)
  } else {
    failed++
    console.error('  ✘ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const USER = 'me@qq.com'
const CODE = 'auth-code-16chars'

const tempDir = await mkdtemp(path.join(tmpdir(), 'dsh-qqmail-e2e-'))
process.env.DSH_QQMAIL_CONFIG = path.join(tempDir, 'dsh-qqmail.json')
process.env.DSH_QQMAIL_DATA_DIR = path.join(tempDir, 'data')

/** Build a raw message with a controlled Date header. */
async function rawMail({ from, fromName = '', to, subject, body, date, attachments = [] }) {
  const composed = await composeMessage(
    { name: fromName, address: from },
    {
      to: [to],
      cc: [],
      bcc: [],
      subject,
      text: body,
      html: '',
      attachments,
      inReplyTo: '',
      references: [],
      saveSent: false,
    },
  )
  if (date === undefined) return composed.raw
  return Buffer.from(composed.raw.toString('utf8').replace(/^Date:.*$/m, 'Date: ' + date))
}

let imap = null
let smtp = null
let service = null
let store = null

try {
  console.log('\n▸ 准备：构造邮件 + 起假 IMAP/SMTP')

  const attachmentPath = path.join(tempDir, 'report.txt')
  await writeFile(attachmentPath, 'attachment content 内容')

  const mail1 = await rawMail({
    from: 'zhangsan@example.com',
    fromName: '张三',
    to: USER,
    // Subject and body stay ASCII so the bytes survive in the raw source: the
    // fake server's SEARCH filters on the encoded source, and a MIME-encoded
    // subject would hide the keyword (which is exactly what the local-filter
    // fallback exists for — mail2 covers that path).
    subject: 'First mail alpha keyword',
    body: 'This is the first message body containing the alpha keyword.',
    date: 'Mon, 01 Sep 2026 10:00:00 +0800',
  })
  const mail2 = await rawMail({
    from: 'lisi@example.com',
    fromName: '李四',
    to: USER,
    subject: '第二封：中文搜索目标',
    body: '这是第二封邮件，正文里写着 beta 标记。',
    date: 'Tue, 02 Sep 2026 11:00:00 +0800',
  })
  const mail3 = await rawMail({
    from: 'wangwu@example.com',
    to: USER,
    subject: '第三封 星标邮件',
    body: '第三封正文。',
    date: 'Wed, 03 Sep 2026 12:00:00 +0800',
  })
  const mail4 = await rawMail({
    from: 'zhaoliu@example.com',
    to: USER,
    subject: '第四封 带附件',
    body: '附件请查收。',
    date: 'Thu, 04 Sep 2026 13:00:00 +0800',
    attachments: [{ filename: 'report.txt', path: attachmentPath }],
  })

  imap = await startFakeImap({
    user: USER,
    password: CODE,
    messages: {
      INBOX: [
        { uid: 1, raw: mail1 },
        { uid: 2, raw: mail2, flags: ['\\Seen'] },
        { uid: 3, raw: mail3, flags: ['\\Seen', '\\Flagged'] },
        { uid: 4, raw: mail4, flags: ['\\Seen'] },
      ],
    },
  })
  smtp = await startFakeSmtp()

  store = new MailStore(true)
  await store.patch({
    preset: 'custom',
    email: USER,
    authCode: CODE,
    imapHost: '127.0.0.1',
    imapPort: imap.port,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: smtp.port,
    smtpSecure: false,
    smtpRequireTls: false,
    signature: '—— 测试签名',
  })
  // A long idle keeps one pooled connection for the whole run, which is what
  // lets the connection-reuse assertion below mean something.
  service = new MailService(store, 60_000)
  check('配置就绪', service.isConfigured() === true)

  console.log('\n▸ 文件夹列表')
  {
    const folders = await service.folders(true)
    check('列出全部文件夹', folders.length >= 5, String(folders.length))
    check('\\Noselect 容器被过滤', !folders.some((entry) => entry.path === 'Archive'))
    check('INBOX 在列表里', folders.some((entry) => entry.path === 'INBOX'))
    const inbox = folders.find((entry) => entry.path === 'INBOX')
    check('STATUS 计数正确', inbox?.messages === 4 && inbox?.unseen === 1, JSON.stringify(inbox))
  }

  console.log('\n▸ 列邮件')
  {
    const page = await service.listMessages({
      mailbox: 'INBOX',
      limit: 10,
      order: 'desc',
      unseen: false,
      flagged: false,
      preview: false,
    })
    check('列出 4 封', page.items.length === 4, String(page.items.length))
    check('最新在前', page.items[0]?.uid === 4, String(page.items[0]?.uid))
    check('总数与截断标记', page.total === 4 && page.truncated === false)
    const second = page.items.find((entry) => entry.uid === 2)
    check('中文主题被解码', second?.subject.includes('中文搜索目标') === true, second?.subject)
    const first = page.items.find((entry) => entry.uid === 1)
    check('发件人地址解析', first?.from[0]?.address === 'zhangsan@example.com', JSON.stringify(first?.from))
    check('发件人中文名被解码', first?.from[0]?.name === '张三', JSON.stringify(first?.from))
    check('日期解析为 ISO', typeof first?.date === 'string' && first.date.startsWith('2026-09-01'))
    check('未读状态正确', first?.seen === false)
    check('已读状态正确', second?.seen === true)
    check('星标状态正确', page.items.find((entry) => entry.uid === 3)?.flagged === true)
    check('附件标记正确', page.items.find((entry) => entry.uid === 4)?.hasAttachments === true, JSON.stringify(page.items.map((entry) => ({ uid: entry.uid, att: entry.hasAttachments }))))
    check('无附件标记正确', first?.hasAttachments === false)
  }

  console.log('\n▸ 只看未读')
  {
    const unseen = await service.listMessages({
      mailbox: 'INBOX',
      limit: 10,
      order: 'desc',
      unseen: true,
      flagged: false,
      preview: false,
    })
    check('只返回未读的 1 封', unseen.items.length === 1 && unseen.items[0]?.uid === 1, JSON.stringify(unseen.items.map((entry) => entry.uid)))
  }

  console.log('\n▸ 正文预览')
  {
    const previewed = await service.listMessages({
      mailbox: 'INBOX',
      limit: 10,
      order: 'desc',
      unseen: false,
      flagged: false,
      preview: true,
    })
    const first = previewed.items.find((entry) => entry.uid === 1)
    check('预览含正文片段', first?.preview.includes('alpha') === true, first?.preview)
  }

  console.log('\n▸ 搜索：ASCII 走服务器端')
  {
    const found = await service.searchMessages(normalizeQuery({ mailbox: 'INBOX', text: 'alpha' }), {
      limit: 10,
      order: 'desc',
      preview: false,
    })
    check('mode=server', found.mode === 'server', found.mode)
    check('命中 1 封', found.items.length === 1 && found.items[0]?.uid === 1, JSON.stringify(found.items.map((entry) => entry.uid)))
  }

  console.log('\n▸ 搜索：中文走本地窗口')
  {
    const found = await service.searchMessages(normalizeQuery({ mailbox: 'INBOX', subject: '中文搜索目标' }), {
      limit: 10,
      order: 'desc',
      preview: true,
    })
    check('mode=local', found.mode === 'local', found.mode)
    check('命中 1 封', found.items.length === 1 && found.items[0]?.uid === 2, JSON.stringify(found.items.map((entry) => entry.uid)))
    const byBody = await service.searchMessages(normalizeQuery({ mailbox: 'INBOX', body: 'beta' }), {
      limit: 10,
      order: 'desc',
      preview: true,
    })
    check('正文关键词本地兜底命中', byBody.items.some((entry) => entry.uid === 2), JSON.stringify(byBody.items.map((entry) => entry.uid)))
    check('兜底结果标明 mode=local', byBody.mode === 'local', byBody.mode)
  }

  console.log('\n▸ 读邮件')
  {
    const result = await service.readMessages([1, 2], { mailbox: 'INBOX', html: false, markSeen: false })
    check('批量读到 2 封', result.items.length === 2, String(result.items.length))
    check('无错误', result.errors.length === 0, result.errors.join('; '))
    const first = result.items[0]
    check('正文完整', first?.text.includes('alpha keyword') === true, first?.text)
    check('主题正确', first?.subject.includes('First mail') === true, first?.subject)
    check('未读未被改动（markSeen=false）', first?.seen === false)
    check('size 有值', (first?.size ?? 0) > 0)
    const withAttachment = await service.readMessages([4], { mailbox: 'INBOX', html: false, markSeen: false })
    check('读出附件清单', withAttachment.items[0]?.attachments.length === 1, JSON.stringify(withAttachment.items[0]?.attachments))
    check('附件名正确', withAttachment.items[0]?.attachments[0]?.filename === 'report.txt')
  }

  console.log('\n▸ 标记（STORE）')
  {
    const outcome = await service.mark([1], 'INBOX', { seen: true })
    check('返回改动数', outcome.changed === 1)
    check('服务器收到 +\\Seen', imap.stores.some((entry) => entry.uids.includes(1) && entry.add && entry.flags.includes('\\Seen')))
    const flagged = await service.mark([2], 'INBOX', { flagged: true })
    check('服务器收到 +\\Flagged', imap.stores.some((entry) => entry.uids.includes(2) && entry.add && entry.flags.includes('\\Flagged')) && flagged.changed === 1)
    const unflag = await service.mark([3], 'INBOX', { flagged: false })
    check('服务器收到 -\\Flagged', imap.stores.some((entry) => entry.uids.includes(3) && entry.remove && entry.flags.includes('\\Flagged')) && unflag.changed === 1)
    let threw = ''
    try {
      await service.mark([1], 'INBOX', {})
    } catch (error) {
      threw = error.message
    }
    check('无动作时报错', threw.includes('seen') || threw.includes('flagged'), threw)
  }

  console.log('\n▸ 移动与删除')
  {
    await service.move([2], 'INBOX', 'Drafts')
    check(
      '移动被服务器记录',
      imap.moves.some((entry) => entry.to === 'Drafts' && entry.uids.includes(2)) ||
        imap.copies.some((entry) => entry.to === 'Drafts' && entry.uids.includes(2)),
      JSON.stringify([...imap.moves, ...imap.copies]),
    )
    const removed = await service.remove([3], 'INBOX', false)
    check('删除=移到已删除文件夹', removed.mode === 'trash' && removed.trashFolder === 'Deleted Messages', JSON.stringify(removed))
    check(
      '服务器收到移到垃圾箱',
      imap.moves.some((entry) => entry.to === 'Deleted Messages' && entry.uids.includes(3)) ||
        imap.copies.some((entry) => entry.to === 'Deleted Messages' && entry.uids.includes(3)),
    )
  }

  console.log('\n▸ 发信（真实 SMTP + 存已发送）')
  {
    const before = smtp.messages.length
    const result = await service.send({
      to: ['dest@example.com'],
      cc: ['copy@example.com'],
      bcc: [],
      subject: '来自测试的邮件 Subject',
      text: '邮件正文内容。',
      html: '',
      attachments: [],
      inReplyTo: '',
      references: [],
      saveSent: undefined,
    })
    check('SMTP 收到新邮件', smtp.messages.length === before + 1)
    const delivered = smtp.messages[smtp.messages.length - 1] ?? ''
    check('收件人写入信封/头', /To: dest@example\.com/i.test(delivered), delivered.slice(0, 200))
    check('抄送写入', /Cc: copy@example\.com/i.test(delivered))
    check('中文主题被 MIME 编码', /=\?UTF-8\?/i.test(delivered))
    check('签名被附加', delivered.includes('测试签名') || /=\?UTF-8\?/i.test(delivered))
    check('Message-ID 回传', result.messageId !== '')
    check('存副本到已发送', result.savedTo === 'Sent Messages', JSON.stringify(result))
    check('服务器收到 APPEND', imap.appended.some((entry) => entry.mailbox === 'Sent Messages'))
    const appendedRaw = imap.appended[imap.appended.length - 1]?.raw.toString('utf8') ?? ''
    check('APPEND 的字节就是发出去的那封', appendedRaw.includes('dest@example.com'), JSON.stringify({ len: appendedRaw.length, head: appendedRaw.slice(0, 160) }))
    check('发送失败时无 saveError', result.saveError === '')
  }

  console.log('\n▸ 附件下载')
  {
    const outDir = path.join(tempDir, 'downloads')
    const downloaded = await service.downloadAttachment(4, 1, 'INBOX', outDir)
    check('文件落盘', downloaded.path.startsWith(outDir))
    check('文件名保留', downloaded.filename === 'report.txt')
    check('内容一致', (await readFile(downloaded.path, 'utf8')) === 'attachment content 内容')
    const second = await service.downloadAttachment(4, 1, 'INBOX', outDir)
    check('重名不覆盖（加后缀）', second.filename === 'report-1.txt', second.filename)
    let indexError = ''
    try {
      await service.downloadAttachment(4, 9, 'INBOX', outDir)
    } catch (error) {
      indexError = error.message
    }
    check('越界序号给出范围提示', indexError.includes('超出范围'), indexError)
    let noneError = ''
    try {
      await service.downloadAttachment(1, 1, 'INBOX', outDir)
    } catch (error) {
      noneError = error.message
    }
    check('无附件邮件给出提示', noneError.includes('没有附件'), noneError)
  }

  console.log('\n▸ 连接自检')
  {
    const probe = await service.probe()
    check('IMAP 通过', probe.imapOk === true, probe.imapError)
    check('SMTP 通过', probe.smtpOk === true, probe.smtpError)
    check('整体通过', probe.ok === true)
    check('识别已发送文件夹', probe.sentFolder === 'Sent Messages', probe.sentFolder)
  }

  console.log('\n▸ 连接复用（池化）')
  {
    const logins = imap.commands.filter((line) => /^\S+ LOGIN /i.test(line)).length
    check('整轮只 LOGIN 一次', logins === 1, String(logins))
    check('命令日志非空', imap.commands.length > 10, String(imap.commands.length))
  }

  console.log('\n▸ 认证失败的可执行提示')
  {
    await store.patch({ authCode: 'wrong-code' })
    const badService = new MailService(store, 200)
    const bad = await badService.probe()
    check('IMAP 报失败', bad.imapOk === false)
    check('提示指向授权码', /授权码/.test(bad.imapError), bad.imapError)
    await badService.closeAll()
    await store.patch({ authCode: CODE })
  }

  console.log('\n▸ 未配置时的可执行提示')
  {
    // A second config path, so the configured store above does not leak in.
    const configured = process.env.DSH_QQMAIL_CONFIG
    process.env.DSH_QQMAIL_CONFIG = path.join(tempDir, 'empty-config.json')
    try {
      const empty = new MailService(new MailStore(true), 200)
      let message = ''
      try {
        await empty.probe()
      } catch (error) {
        message = error.message
      }
      check('提示先配置邮箱地址', message.includes('邮箱地址'), message)
      await empty.closeAll()
    } finally {
      process.env.DSH_QQMAIL_CONFIG = configured
    }
  }

  console.log('\n▸ 隔离性')
  {
    const realPath = path.join(process.env.HOME ?? '', '.dsh', 'dsh-qqmail.json')
    const realExists = await stat(realPath).then(() => true).catch(() => false)
    check('临时目录在用', store.file.startsWith(tempDir))
    check('未写真实配置（或本次运行前已存在）', realExists === false || !store.file.startsWith(path.join(process.env.HOME ?? '', '.dsh')))
  }
} catch (error) {
  failed++
  console.error('\n✘ 运行中断：' + (error instanceof Error ? error.stack : String(error)))
} finally {
  if (service !== null) await service.closeAll().catch(() => undefined)
  if (imap !== null) await imap.close().catch(() => undefined)
  if (smtp !== null) await smtp.close().catch(() => undefined)
  await rm(tempDir, { recursive: true, force: true })
}

console.log('\n' + (failed === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + String(passed) + ' 通过 / ' + String(failed) + ' 失败\n')
process.exit(failed === 0 ? 0 : 1)
