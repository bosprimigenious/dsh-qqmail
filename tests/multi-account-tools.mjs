/** Real loopback sockets, synthetic credentials, isolated config; no external mail. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MailStore, MailService, buildSpecs, composeMessage, parseSource } from '../lib/index.js'
import { startFakeImap, startFakeSmtp } from './fakes.mjs'

const temp = await mkdtemp(path.join(tmpdir(), 'dsh-qqmail-multi-tools-'))
process.env.DSH_QQMAIL_CONFIG = path.join(temp, 'config.json')
process.env.DSH_QQMAIL_DATA_DIR = path.join(temp, 'data')
const servers = []
let service
let passed = 0
let failed = 0
async function test(label, fn) {
  try { await fn(); passed++; console.log('  ✔ ' + label) }
  catch (error) { failed++; console.error('  ✘ ' + label + ' — ' + error.message) }
}
const users = ['alpha@example.test', 'beta@example.test']
const secrets = ['synthetic-alpha-credential', 'synthetic-beta-credential', 'synthetic-gamma-credential', 'synthetic-delta-credential']
const ids = ['alpha', 'beta']
const bodies = ['ACCOUNT_ALPHA_BODY', 'ACCOUNT_BETA_BODY']
const signatures = ['SIGNATURE_ALPHA_ONLY', 'SIGNATURE_BETA_ONLY']
const imaps = []
const smtps = []
try {
  console.log('\n▸ 双账号工具集成（仅 127.0.0.1）')
  const store = new MailStore(false)
  for (let i = 0; i < 2; i++) {
    const attachment = path.join(temp, ids[i] + '.txt')
    await writeFile(attachment, 'ATTACHMENT_' + ids[i])
    const { raw } = await composeMessage({ name: 'Sender', address: 'sender@example.test' }, {
      to: [users[i]], cc: [], bcc: [], subject: 'SUBJECT_' + ids[i], text: bodies[i], html: '',
      attachments: [{ filename: ids[i] + '.txt', path: attachment }],
      inReplyTo: '', references: [], saveSent: false,
    })
    const imap = await startFakeImap({ user: users[i], password: secrets[i], messages: { INBOX: [{ uid: 100, raw }] } })
    servers.push(imap); imaps.push(imap)
    const smtp = await startFakeSmtp()
    servers.push(smtp); smtps.push(smtp)
    await store.patch({
      account: '__new__', id: ids[i], email: users[i], authCode: secrets[i], preset: 'custom',
      imapHost: '127.0.0.1', imapPort: imap.port, imapSecure: false,
      smtpHost: '127.0.0.1', smtpPort: smtp.port, smtpSecure: false, smtpRequireTls: false,
      signature: signatures[i], fromName: 'FROM_' + ids[i], downloadDir: path.join(temp, 'downloads-' + ids[i]),
      previewInList: i === 1, saveSent: i === 0,
    })
  }
  service = new MailService(store, 60_000)
  const specs = new Map(buildSpecs(false).map((s) => [s.name, s]))
  const ctx = { store, service, workspaceDir: temp }
  async function call(name, args = {}, expected = true) {
    assert.ok(specs.has(name), 'missing tool ' + name)
    const result = await specs.get(name).handler(args, ctx)
    assert.equal(result.ok, expected, result.message)
    for (const secret of secrets) assert.ok(!JSON.stringify(result).includes(secret), 'credential leaked by ' + name)
    return result
  }
  function identity(result, i) { assert.deepEqual(result.data.account, { id: ids[i], email: users[i] }) }
  await test('全部 12 个现有工具声明可选 account', () => {
    for (const name of ['status', 'config', 'folders', 'list', 'search', 'read', 'attachment', 'send', 'reply', 'mark', 'move', 'delete']) {
      const parameter = specs.get('qqmail_' + name)?.parameters.account
      assert.equal(parameter?.type, 'string', name)
      assert.notEqual(parameter.required, true, name)
    }
  })
  await test('多账号不传 account 读默认账号相同 uid 并回显身份', async () => {
    const result = await call('qqmail_read', { uid: 100 })
    assert.ok(result.data.items[0].text.includes(bodies[0]))
    assert.ok(!result.data.items[0].text.includes(bodies[1]))
    identity(result, 0)
  })
  for (const ref of ['beta', 'BETA@EXAMPLE.TEST']) {
    await test('指定 ' + ref + ' 读另一账号的 uid=100', async () => {
      const result = await call('qqmail_read', { uid: 100, account: ref })
      assert.ok(result.data.items[0].text.includes(bodies[1]))
      assert.ok(!result.data.items[0].text.includes(bodies[0]))
      identity(result, 1)
    })
  }
  await test('账号级 previewInList 隔离', async () => {
    const a = await call('qqmail_list', { account: 'alpha' })
    const b = await call('qqmail_list', { account: 'beta' })
    assert.equal(a.data.items[0].preview, '')
    // The fake's multipart BODY[1] includes boundaries; test the toggle and
    // mailbox identity without treating that fixture as a MIME part parser.
    assert.notEqual(b.data.items[0].preview, '')
    assert.equal(b.data.items[0].subject, 'SUBJECT_beta')
    identity(a, 0); identity(b, 1)
  })
  await test('显式账号搜索命中对应服务器', async () => {
    const result = await call('qqmail_search', { account: 'beta', subject: 'SUBJECT_beta' })
    assert.equal(result.data.items[0].subject, 'SUBJECT_beta')
    identity(result, 1)
  })
  await test('并发 probe 分别验证两个真实假服务器', async () => {
    const results = await Promise.all(ids.map((account) => call('qqmail_status', { account, probe: true })))
    for (let i = 0; i < 2; i++) { assert.equal(results[i].data.probe.ok, true); identity(results[i], i) }
  })
  for (let i = 0; i < 2; i++) {
    await test('发送 ' + ids[i] + ' 的 From、签名、saveSent 隔离', async () => {
      const before = smtps[i].messages.length
      const otherBefore = smtps[1 - i].messages.length
      const result = await call('qqmail_send', { account: ids[i], to: ['recipient@example.test'], subject: 'send-' + ids[i], text: 'PAYLOAD' })
      identity(result, i)
      assert.equal(smtps[i].messages.length, before + 1)
      assert.equal(smtps[1 - i].messages.length, otherBefore)
      const { parsed } = await parseSource(Buffer.from(smtps[i].messages.at(-1)), false)
      assert.equal(parsed.from.value[0].address, users[i])
      assert.equal(parsed.from.value[0].name, 'FROM_' + ids[i])
      assert.ok(parsed.text.includes(signatures[i]))
      assert.ok(!parsed.text.includes(signatures[1 - i]))
      assert.equal(result.data.savedTo !== '', i === 0)
      assert.equal(imaps[i].appended.length, i === 0 ? 1 : 0)
    })
  }
  await test('beta 回复读取 beta 原信并使用 beta 签名', async () => {
    const result = await call('qqmail_reply', { account: 'beta', uid: 100, text: 'BETA_REPLY', quoteOriginal: true })
    identity(result, 1)
    const { parsed } = await parseSource(Buffer.from(smtps[1].messages.at(-1)), false)
    assert.equal(parsed.from.value[0].address, users[1])
    assert.ok(parsed.text.includes(bodies[1]))
    assert.ok(!parsed.text.includes(bodies[0]))
    assert.ok(parsed.text.includes(signatures[1]))
    assert.ok(!parsed.text.includes(signatures[0]))
  })
  await test('附件下载使用各自账号 downloadDir 和内容', async () => {
    for (let i = 0; i < 2; i++) {
      const result = await call('qqmail_attachment', { account: ids[i], uid: 100, index: 1 })
      identity(result, i)
      assert.equal(path.dirname(result.data.path), path.join(temp, 'downloads-' + ids[i]))
      assert.equal(await readFile(result.data.path, 'utf8'), 'ATTACHMENT_' + ids[i])
    }
  })
  const invalidCases = {
    status: {}, config: { signature: 'DO_NOT_SAVE' }, folders: {}, list: {}, search: { subject: 'x' },
    read: { uid: 100 }, attachment: { uid: 100, index: 1 }, send: { to: ['recipient@example.test'], text: 'x' },
    reply: { uid: 100, text: 'x' }, mark: { uid: 100, seen: true }, move: { uid: 100, destination: 'Drafts' }, delete: { uid: 100 },
  }
  for (const [name, args] of Object.entries(invalidCases)) {
    await test('未知 account 被 ' + name + ' 明确拒绝且不修改配置', async () => {
      const disk = await readFile(store.file, 'utf8')
      const sent = smtps.map((s) => s.messages.length)
      const commands = imaps.map((s) => s.commands.length)
      const result = await call('qqmail_' + name, { ...args, account: 'missing-account' }, false)
      assert.match(result.message, /alpha/); assert.match(result.message, /beta/)
      assert.equal(await readFile(store.file, 'utf8'), disk)
      assert.deepEqual(smtps.map((s) => s.messages.length), sent)
      assert.deepEqual(imaps.map((s) => s.commands.length), commands)
    })
  }
  await test('标记 beta 的相同 uid 不影响 alpha', async () => {
    const before = imaps[0].stores.length
    const result = await call('qqmail_mark', { account: 'beta', uid: 100, flagged: true })
    identity(result, 1)
    assert.equal(imaps[0].stores.length, before)
    assert.ok(imaps[1].folder('INBOX')[0].flags.has('\\Flagged'))
  })
  await test('accounts 列表、设默认并验证不传账号的行为', async () => {
    const list = await call('qqmail_accounts')
    assert.equal(list.data.accounts.length, 2)
    await call('qqmail_accounts', { action: 'setDefault', account: 'beta' })
    const result = await call('qqmail_read', { uid: 100 })
    assert.ok(result.data.items[0].text.includes(bodies[1]))
    identity(result, 1)
  })
  await test('qqmail_config __new__ 新增及 label、定向修改隔离', async () => {
    const original = store.view('alpha').signature
    await call('qqmail_config', { account: '__new__', id: 'gamma', label: 'Gamma label', email: 'gamma@example.test', authCode: 'synthetic-gamma-credential' })
    const result = await call('qqmail_accounts')
    assert.equal(result.data.accounts.find((a) => a.id === 'gamma').label, 'Gamma label')
    await call('qqmail_config', { account: 'gamma', signature: 'GAMMA_SIGNATURE' })
    assert.equal(store.view('alpha').signature, original)
    assert.equal(store.view('gamma').signature, 'GAMMA_SIGNATURE')
  })
  await test('修改邮箱和 id 后配置结果回显新的身份', async () => {
    const result = await call('qqmail_config', { account: 'gamma', id: 'gamma-renamed', email: 'gamma-renamed@example.test' })
    assert.deepEqual(result.data.account, { id: 'gamma-renamed', email: 'gamma-renamed@example.test' })
    assert.equal(store.view('gamma-renamed').email, 'gamma-renamed@example.test')
  })
  await test('accounts add/remove 需要确认，删除默认后回落', async () => {
    await call('qqmail_accounts', { action: 'add', id: 'delta', email: 'delta@example.test', authCode: 'synthetic-delta-credential' })
    assert.equal(store.listAccounts().accounts.length, 4)
    const refusal = await call('qqmail_accounts', { action: 'remove', account: 'delta' }, false)
    assert.match(refusal.message, /confirm|确认/)
    assert.equal(store.listAccounts().accounts.length, 4)
    await call('qqmail_accounts', { action: 'remove', account: 'delta', confirm: true })
    await call('qqmail_accounts', { action: 'remove', account: 'beta', confirm: true })
    const result = await call('qqmail_read', { uid: 100 })
    assert.ok(result.data.items[0].text.includes(bodies[0]))
    assert.equal(store.listAccounts().resolvedDefaultAccount, 'alpha')
  })
  await test('显式 reset 只重置目标账号，无参 reset 清空全部', async () => {
    const alpha = store.view('alpha')
    await call('qqmail_config', { account: 'gamma-renamed', reset: true })
    assert.equal(store.view('gamma-renamed').email, '')
    assert.equal(store.view('alpha').email, alpha.email)
    assert.equal(store.view('alpha').authCodeSet, alpha.authCodeSet)
    await call('qqmail_config', { reset: true })
    assert.equal(store.listAccounts().accounts.length, 0)
    assert.equal(store.readOnlySync().value, false)
  })
} catch (error) {
  failed++; console.error('  ✘ 测试准备或清理前执行失败 — ' + error.stack)
} finally {
  if (service) await service.dispose()
  await Promise.all(servers.map((server) => server.close()))
  await rm(temp, { recursive: true, force: true })
}
console.log('\n双账号工具集成：' + passed + ' 通过，' + failed + ' 失败')
if (failed) process.exitCode = 1
