/** Offline configuration migration, account isolation and failure-path tests. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { MailStore, MailService, ImapSession } from '../lib/index.js'

const root = await fs.mkdtemp(path.join(tmpdir(), 'qqmail-multi-'))
let passed = 0
const create = async (name, raw) => {
  const file = path.join(root, name, 'dsh-qqmail.json')
  await fs.mkdir(path.dirname(file), { recursive: true })
  if (raw !== undefined) await fs.writeFile(file, raw, { mode: 0o600 })
  process.env.DSH_QQMAIL_CONFIG = file
  return new MailStore()
}
const check = async (label, run) => { await run(); passed++; console.log('  ✔ ' + label) }
const v1 = '{\r\n "email":"legacy@foxmail.com", "authCode":"test-secret-legacy", "preset":"qq", "signature":"Legacy", "readOnly":false, "saveSent":false, "previewInList":true, "downloadDir":"/tmp/legacy", "timeoutMs":45000\r\n}\r\n'
const add = (store, id, extra = {}) => store.patch({ account: '__new__', id, email: id + '@qq.com', authCode: 'test-secret-' + id, ...extra })
const inject = async (name, replacement, run) => {
  const original = fs[name]
  fs[name] = replacement(original)
  syncBuiltinESMExports()
  try { await run() } finally { fs[name] = original; syncBuiltinESMExports() }
}

try {
  await check('v1 只在内存迁移，读取不创建备份、不改变字节和 mtime', async () => {
    const s = await create('v1-read', v1)
    const before = await fs.stat(s.file)
    const c = s.readSync()
    assert.equal(c.version, 2)
    assert.equal(c.defaultAccount, 'legacy')
    assert.equal(c.readOnly, false)
    assert.equal(c.accounts[0].signature, 'Legacy')
    assert.equal(c.accounts[0].saveSent, false)
    assert.equal(c.accounts[0].downloadDir, '/tmp/legacy')
    assert.equal(c.accounts[0].readOnly, undefined)
    assert.equal(await fs.readFile(s.file, 'utf8'), v1)
    assert.equal((await fs.stat(s.file)).mtimeMs, before.mtimeMs)
    await assert.rejects(fs.stat(s.file + '.v1.bak'), { code: 'ENOENT' })
  })
  await check('首次写回精确备份、两文件 0600、后续不覆盖备份', async () => {
    const s = await create('v1-write', v1)
    await s.patch({ signature: 'Updated' })
    assert.equal(await fs.readFile(s.file + '.v1.bak', 'utf8'), v1)
    assert.equal((await fs.stat(s.file)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(s.file + '.v1.bak')).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await fs.readFile(s.file, 'utf8')).version, 2)
    await s.patch({ fromName: 'Name' })
    assert.equal(await fs.readFile(s.file + '.v1.bak', 'utf8'), v1)
  })
  await check('备份发布失败保留 v1 文件与内存', async () => {
    const s = await create('backup-fail', v1)
    const before = JSON.stringify(s.readSync())
    await inject('link', (original) => async (...args) => {
      if (String(args[1]).endsWith('.v1.bak')) throw new Error('injected backup failure')
      return original(...args)
    }, () => assert.rejects(s.patch({ signature: 'Lost' }), /injected/))
    assert.equal(await fs.readFile(s.file, 'utf8'), v1)
    assert.equal(JSON.stringify(s.readSync()), before)
    assert.deepEqual(await fs.readdir(path.dirname(s.file)), ['dsh-qqmail.json'])
    await s.patch({ signature: 'Recovered' })
    assert.equal(s.view().signature, 'Recovered')
  })
  await check('rename 失败保留原文件/缓存；已发布备份有效；临时文件清除', async () => {
    const s = await create('rename-fail', v1)
    const before = JSON.stringify(s.readSync())
    await inject('rename', () => async () => { throw new Error('injected rename failure') },
      () => assert.rejects(s.patch({ signature: 'Lost' }), /injected/))
    assert.equal(await fs.readFile(s.file, 'utf8'), v1)
    assert.equal(JSON.stringify(s.readSync()), before)
    assert.equal(await fs.readFile(s.file + '.v1.bak', 'utf8'), v1)
    assert.equal((await fs.readdir(path.dirname(s.file))).filter((f) => f.endsWith('.tmp')).length, 0)
    await s.patch({ signature: 'Recovered' })
  })
  await check('临时文件 fsync 失败不能替换原配置', async () => {
    const s = await create('sync-fail', v1)
    await inject('open', (original) => async (...args) => {
      const handle = await original(...args)
      if (String(args[0]).endsWith('.tmp')) handle.sync = async () => { throw new Error('injected sync failure') }
      return handle
    }, () => assert.rejects(s.patch({ signature: 'Lost' }), /injected/))
    assert.equal(await fs.readFile(s.file, 'utf8'), v1)
    assert.equal((await fs.readdir(path.dirname(s.file))).filter((f) => f.endsWith('.tmp')).length, 0)
  })
  await check('损坏 JSON、未知版本、非法 v2 和重复邮箱均拒绝覆盖', async () => {
    const cases = ['{bad', '{"version":3}', '{"version":2,"accounts":{}}', '{"accounts":[]}', '{"version":2,"accounts":[{"id":"a","email":"same@qq.com"},{"id":"b","email":"SAME@qq.com"}]}']
    for (const [i, raw] of cases.entries()) {
      const s = await create('bad-' + i, raw)
      assert.doesNotThrow(() => s.view())
      await assert.rejects(s.patch({ email: 'new@qq.com' }), /拒绝覆盖/)
      assert.equal(await fs.readFile(s.file, 'utf8'), raw)
    }
  })
  await check('两实例同时添加/修改账号不会丢更新，缓存随写入失效', async () => {
    const a = await create('concurrent')
    const b = new MailStore()
    b.readSync()
    await Promise.all([add(a, 'a'), add(b, 'b')])
    await Promise.all([a.patch({ account: 'a', signature: 'A' }), b.patch({ account: 'b', signature: 'B' })])
    assert.equal(a.listAccounts().accounts.length, 2)
    assert.equal(a.view('a').signature, 'A')
    assert.equal(b.view('b').signature, 'B')
    assert.equal(JSON.parse(await fs.readFile(a.file, 'utf8')).accounts.length, 2)
  })
  await check('id/email 解析、账号签名与选项隔离、显式未知引用拒绝', async () => {
    const s = await create('resolve')
    await add(s, 'a', { signature: 'A', fromName: 'Alpha', saveSent: false, previewInList: true, downloadDir: '/tmp/a' })
    await add(s, 'b', { signature: 'B', fromName: 'Beta', saveSent: true, previewInList: false, downloadDir: '/tmp/b' })
    const service = new MailService(s)
    try {
      assert.equal(service.accountOrThrow().email, 'a@qq.com')
      const b = service.accountOrThrow('B@QQ.COM')
      assert.equal(b.signature, 'B')
      assert.equal(b.fromName, 'Beta')
      assert.equal(b.saveSent, true)
      assert.equal(b.previewInList, false)
      assert.equal(b.downloadDir, '/tmp/b')
      assert.throws(() => service.accountOrThrow('missing'), /可选账号：a .*b /)
      assert.throws(() => service.accountOrThrow(''), /账号不存在/)
      await assert.rejects(s.patch({ account: 'missing', signature: 'Bad' }), /账号不存在/)
      await s.patch({ defaultAccount: 'B@QQ.COM' })
      assert.equal(service.accountOrThrow().email, 'b@qq.com')
      const publicJson = JSON.stringify(s.listAccounts())
      assert.equal(publicJson.includes('test-secret-'), false)
      assert.equal(publicJson.includes('"authCode":'), false)
    } finally { await service.dispose() }
  })
  await check('默认失效回落、提示保留、删除最后账号与 reset 两种作用域', async () => {
    const s = await create('fallback')
    await add(s, 'a')
    await add(s, 'b')
    await s.patch({ readOnly: false })
    await assert.rejects(s.patch({ account: 'a', remove: true }), /confirm/)
    await s.patch({ account: 'a', remove: true, confirm: true })
    assert.equal(s.view().email, 'b@qq.com')
    assert.match(s.listAccounts().warning, /回落到 b/)
    await s.patch({ account: 'b', reset: true })
    assert.equal(s.listAccounts().accounts[0].id, 'b')
    assert.equal(s.view().email, '')
    assert.equal(s.readOnlySync().value, false)
    await s.patch({ reset: true })
    assert.equal(s.readSync().accounts.length, 0)
    assert.equal(s.readOnlySync().value, true)
    const service = new MailService(s)
    assert.throws(() => service.accountOrThrow(), /尚未配置邮箱地址/)
    await service.dispose()
    assert.equal(JSON.parse(await fs.readFile(s.file, 'utf8')).accounts.length, 0)
  })
  await check('自动 id 去重、显式重复/非法 id 与重复邮箱拒绝；改邮箱保留 id', async () => {
    const s = await create('ids')
    await s.patch({ email: 'same@qq.com', authCode: 'test-code' })
    await s.patch({ account: '__new__', email: 'same@foxmail.com', authCode: 'test-code' })
    assert.deepEqual(s.readSync().accounts.map((a) => a.id), ['same', 'same-2'])
    await assert.rejects(add(s, 'same'), /id 重复/)
    await assert.rejects(add(s, 'INVALID'), /id/)
    await assert.rejects(add(s, '__new__'), /id/)
    await assert.rejects(add(s, 'other', { email: 'SAME@QQ.COM' }), /重复/)
    await s.patch({ account: 'same', email: 'new@163.com' })
    assert.equal(s.readSync().accounts[0].id, 'same')
    assert.equal(s.view('same').preset, '163')
  })
  await check('第 10 个账号可写，第 11 个拒绝且原文件不变', async () => {
    const s = await create('limit')
    for (let i = 0; i < 10; i++) await add(s, 'a' + i)
    const before = await fs.readFile(s.file, 'utf8')
    await assert.rejects(add(s, 'a10'), /上限 10/)
    assert.equal(await fs.readFile(s.file, 'utf8'), before)
  })
  await check('直接 Store patch 只关闭目标账号，清除 Sent/Trash 缓存，失败不清理', async () => {
    const s = await create('sessions')
    await add(s, 'a')
    await add(s, 'b')
    const service = new MailService(s)
    const closed = []
    try {
      service.sessions.set('a@qq.com|host|993|digest', { retire: async () => { closed.push('a') } })
      service.sessions.set('b@qq.com|host|993|digest', { retire: async () => { closed.push('b') } })
      service.sentFolders.set('a@qq.com', 'old-sent')
      service.sentFolders.set('a@qq.com:trash', 'old-trash')
      service.sentFolders.set('b@qq.com', 'keep')
      await inject('rename', () => async () => { throw new Error('injected') },
        () => assert.rejects(s.patch({ account: 'a', authCode: 'changed' }), /injected/))
      assert.deepEqual(closed, [])
      await s.patch({ account: 'a', imapPort: 143, imapSecure: false, timeoutMs: 40000 })
      assert.deepEqual(closed, ['a'])
      assert.equal(service.sessions.size, 1)
      assert.equal(service.sentFolders.has('a@qq.com'), false)
      assert.equal(service.sentFolders.has('a@qq.com:trash'), false)
      assert.equal(service.sentFolders.get('b@qq.com'), 'keep')
      await s.patch({ account: 'b', email: 'renamed@qq.com' })
      assert.deepEqual(closed, ['a', 'b'])
    } finally { await service.dispose() }
  })
  await check('session 退休等待正在打开/执行的请求，拒绝新请求，不会重新泄漏', async () => {
    const session = new ImapSession({ host: 'invalid', port: 993, secure: true, user: 'fake', pass: 'fake', timeoutMs: 1000 }, 0)
    let release
    const opening = new Promise((resolve) => { release = resolve })
    let dropped = false
    session.ensure = async () => { await opening; return {} }
    session.drop = async () => { dropped = true }
    const run = session.run(async () => 'done')
    const retirement = session.retire()
    await assert.rejects(session.run(async () => 'new'), /配置已变更/)
    assert.equal(dropped, false)
    release()
    assert.equal(await run, 'done')
    await retirement
    assert.equal(dropped, true)
  })
  await check('v1 空格邮箱可正确清理；旧快照不能重建连接或重新污染缓存', async () => {
    const s = await create('generation', v1.replace('legacy@foxmail.com', ' legacy@foxmail.com '))
    const service = new MailService(s)
    const account = service.accountOrThrow()
    let retired = false
    service.sessions.set('legacy@foxmail.com|host|993|digest', {
      retire: async () => {
        retired = true
        const client = { list: async () => [{ path: 'Old Sent', name: 'Old Sent', specialUse: '\\Sent', flags: new Set(), delimiter: '/', subscribed: true }] }
        await service.resolveSentFolder(client, account)
      },
    })
    await s.patch({ authCode: 'replacement-code' })
    assert.equal(retired, true)
    assert.equal(service.sessions.size, 0)
    assert.equal(service.sentFolders.size, 0)
    assert.throws(() => service.session(account), /配置已变更/)
    await service.dispose()
  })
  await check('port、secure、timeout、authCode 每个字段单独变更都退休目标 session', async () => {
    const s = await create('field-invalidation')
    await add(s, 'a')
    await add(s, 'b')
    const service = new MailService(s)
    service.session(service.accountOrThrow('b'))
    for (const patch of [{ imapPort: 143 }, { imapSecure: false }, { timeoutMs: 45000 }, { authCode: 'new-code' }]) {
      const account = service.accountOrThrow('a')
      const session = service.session(account)
      let retired = false
      session.retire = async () => { retired = true }
      await s.patch({ account: 'a', ...patch })
      assert.equal(retired, true)
      assert.equal(service.sessions.size, 1)
      assert.throws(() => service.session(account), /配置已变更/)
    }
    await service.dispose()
  })
  await check('备份目录 fsync 失败必须停在原 v1；不能提前替换配置', async () => {
    const s = await create('backup-directory-failure', v1)
    await inject('open', (original) => async (...args) => {
      const handle = await original(...args)
      if (args[0] === path.dirname(s.file)) handle.sync = async () => { throw new Error('injected directory failure') }
      return handle
    }, () => assert.rejects(s.patch({ signature: 'Lost' }), /injected/))
    assert.equal(await fs.readFile(s.file, 'utf8'), v1)
    assert.equal(await fs.readFile(s.file + '.v1.bak', 'utf8'), v1)
  })
  await check('rename 后目录同步失败明确已保存，缓存与磁盘一致', async () => {
    const s = await create('commit-directory-failure')
    await add(s, 'a')
    await inject('open', (original) => async (...args) => {
      const handle = await original(...args)
      if (args[0] === path.dirname(s.file)) handle.sync = async () => { throw new Error('injected directory failure') }
      return handle
    }, () => assert.rejects(s.patch({ signature: 'Saved' }), /配置已保存/))
    assert.equal(s.view().signature, 'Saved')
    assert.equal(JSON.parse(await fs.readFile(s.file, 'utf8')).accounts[0].signature, 'Saved')
  })
  await check('dispose 解绑并禁止后续请求重新创建连接', async () => {
    const s = await create('dispose')
    await add(s, 'a')
    const service = new MailService(s)
    await service.dispose()
    await assert.rejects(service.folders(), /服务已卸载/)
    assert.equal(service.sessions.size, 0)
    await s.patch({ authCode: 'after-dispose' })
    assert.equal(service.sessions.size, 0)
  })
  console.log('\n✅ 多账号核心：' + passed + ' 通过 / 0 失败')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
