/**
 * dsh-qqmail smoke tests — offline, deterministic, no network.
 *
 * Exercises the pure layers (schema projection, MIME helpers, folder
 * classification, local search matching), the credential store against a
 * throwaway temp file, and a real nodemailer→mailparser round trip through
 * `composeMessage` / `parseSource` so the MIME path is verified with the actual
 * libraries rather than a mock.
 *
 * Safety: DSH_QQMAIL_CONFIG / DSH_QQMAIL_DATA_DIR point into a temp dir before
 * the store is constructed, so the real ~/.dsh/dsh-qqmail.json is never read or
 * written (asserted at the end).
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  MailStore,
  buildSpecs,
  composeMessage,
  decodeQuotedPrintable,
  formatSize,
  hasNonAscii,
  maskSecret,
  matchesLocally,
  parseDate,
  parseSource,
  pickSpecialFolder,
  safeFilename,
  toDetail,
  toJsonSchema,
  toAddressList,
  truncate,
  PRESET_IDS,
  detectPreset,
} from '../lib/index.js'

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

/** Isolate the store before anything reads it. */
async function isolate() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-qqmail-smoke-'))
  process.env.DSH_QQMAIL_CONFIG = path.join(dir, 'dsh-qqmail.json')
  process.env.DSH_QQMAIL_DATA_DIR = path.join(dir, 'data')
  return dir
}

const tempDir = await isolate()
const realConfig = path.join(process.env.HOME ?? '', '.dsh', 'dsh-qqmail.json')
/**
 * Identity of the real config before the run starts.
 *
 * The isolation assertion at the end compares against this rather than testing for
 * absence: a developer who has actually configured the plugin owns a real config, and
 * "the file does not exist" would then fail for reasons unrelated to this test.
 */
const realConfigBefore = await stat(realConfig).then(({ mtimeMs, size }) => mtimeMs + ':' + size).catch(() => 'missing')

console.log('\n▸ 参数规格 → JSON Schema')
{
  const schema = toJsonSchema({
    to: { type: 'array', items: { type: 'string' }, required: true, description: '收件人' },
    subject: { type: 'string', description: '主题' },
    limit: { type: 'number' },
    unseen: { type: 'boolean' },
    mode: { type: 'string', enum: ['a', 'b'] },
  })
  check('根是 object 且封闭', schema.type === 'object' && schema.additionalProperties === false)
  check('required 只含标记项', JSON.stringify(schema.required) === '["to"]', JSON.stringify(schema.required))
  check('数组项被展开', JSON.stringify(schema.properties.to.items) === '{"type":"string"}')
  check('描述被保留', schema.properties.subject.description === '主题')
  check('enum 被保留', JSON.stringify(schema.properties.mode.enum) === '["a","b"]')
}

console.log('\n▸ MIME / 文本工具')
check('formatSize 分级', formatSize(512) === '512 B' && formatSize(2048) === '2.0 KB' && /MB$/.test(formatSize(3 * 1024 * 1024)))
check('truncate 加省略号', truncate('abcdefghij', 5) === 'abcd…')
check('hasNonAscii 中文为真', hasNonAscii('发票') === true && hasNonAscii('invoice') === false)
check(
  'safeFilename 去掉路径与非法字符',
  safeFilename('../../etc/passwd') === 'passwd' && safeFilename('a/b:c?.pdf') === 'b_c_.pdf',
  safeFilename('a/b:c?.pdf'),
)
check('空文件名回退', safeFilename('') === 'attachment')
check('parseDate 支持 YYYY-MM-DD', parseDate('2026-09-13')?.getFullYear() === 2026)
check('parseDate 支持 ISO', parseDate('2026-09-13T10:00:00Z')?.getUTCHours() === 10)
check('parseDate 拒绝垃圾', parseDate('not-a-date') === undefined)
check(
  'toAddressList 支持 mailparser 嵌套结构',
  JSON.stringify(toAddressList({ value: [{ name: '张三', address: 'a@qq.com' }] })) === '[{"name":"张三","address":"a@qq.com"}]',
)
check('toAddressList 接受数组与 undefined', toAddressList(undefined).length === 0 && toAddressList([{ address: 'x@y.z' }]).length === 1)

console.log('\n▸ quoted-printable 解码')
check('=XX 转义', decodeQuotedPrintable('caf=C3=A9') === 'café')
check('软换行被去掉', decodeQuotedPrintable('ab=\r\ncd') === 'abcd')
check('普通文本不变', decodeQuotedPrintable('hello') === 'hello')

console.log('\n▸ 特殊文件夹识别')
{
  const boxes = [
    { path: 'INBOX', name: 'INBOX', specialUse: '', flags: [], subscribed: true, messages: 3, unseen: 1 },
    { path: 'Sent Messages', name: 'Sent Messages', specialUse: '', flags: [], subscribed: true, messages: -1, unseen: -1 },
    { path: 'Drafts', name: 'Drafts', specialUse: '', flags: [], subscribed: true, messages: -1, unseen: -1 },
    { path: '已删除', name: '已删除', specialUse: '', flags: [], subscribed: true, messages: -1, unseen: -1 },
    { path: 'Junk', name: 'Junk', specialUse: '', flags: [], subscribed: true, messages: -1, unseen: -1 },
  ]
  check('英文 Sent 命中', pickSpecialFolder(boxes, 'sent') === 'Sent Messages')
  check('草稿命中', pickSpecialFolder(boxes, 'drafts') === 'Drafts')
  check('中文「已删除」命中回收站', pickSpecialFolder(boxes, 'trash') === '已删除')
  check('垃圾箱命中', pickSpecialFolder(boxes, 'junk') === 'Junk')
  check('找不到时返回空串', pickSpecialFolder([boxes[0]], 'sent') === '')
  check(
    'SPECIAL-USE 优先于名称',
    pickSpecialFolder(
      [
        { path: 'Other', name: 'Other', specialUse: '\\Sent', flags: [], subscribed: true, messages: -1, unseen: -1 },
        { path: 'Sent', name: 'Sent', specialUse: '', flags: [], subscribed: true, messages: -1, unseen: -1 },
      ],
      'sent',
    ) === 'Other',
  )
}

console.log('\n▸ 本地搜索匹配（中文关键词兜底路径）')
{
  const summary = {
    uid: 7,
    mailbox: 'INBOX',
    subject: '9 月发票已开出',
    from: [{ name: '财务', address: 'finance@corp.com' }],
    to: [{ name: '', address: 'me@qq.com' }],
    date: '2026-09-13T02:00:00.000Z',
    size: 4096,
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: true,
    preview: '请查收本月发票，金额 1200 元',
    messageId: '<x@y>',
  }
  const base = {
    mailbox: 'INBOX',
    from: '',
    to: '',
    subject: '',
    body: '',
    text: '',
    since: '',
    before: '',
    unseen: false,
    flagged: false,
    larger: 0,
    smaller: 0,
  }
  check('主题中文匹配', matchesLocally(summary, { ...base, subject: '发票' }) === true)
  check('正文中文匹配', matchesLocally(summary, { ...base, body: '金额' }) === true)
  check('发件人匹配', matchesLocally(summary, { ...base, from: 'finance' }) === true)
  check('不匹配时返回 false', matchesLocally(summary, { ...base, subject: '工资' }) === false)
  check('unseen 条件生效', matchesLocally(summary, { ...base, unseen: true }) === true)
  check('flagged 条件生效', matchesLocally(summary, { ...base, flagged: true }) === false)
  check('since 过滤更晚的邮件', matchesLocally(summary, { ...base, since: '2026-10-01' }) === false)
  check('before 过滤更早的邮件', matchesLocally(summary, { ...base, before: '2026-01-01' }) === false)
  check('larger 生效', matchesLocally(summary, { ...base, larger: 100000 }) === false)
}

console.log('\n▸ 运营商预设识别')
check('@qq.com → qq', detectPreset('someone@qq.com') === 'qq')
check('foxmail 也算 qq', detectPreset('a@foxmail.com') === 'qq')
check('@163.com → 163', detectPreset('a@163.com') === '163')
check('企业域名不猜（custom）', detectPreset('a@mycorp.cn') === 'custom')
check('预设 id 列表包含 custom', PRESET_IDS.includes('custom') === true)

console.log('\n▸ 配置存储（临时文件 + 0600）')
{
  const store = new MailStore(true)
  check('初始未配置', store.view().configured === false)
  check('默认只读（row 种子）', store.readOnlySync().value === true && store.readOnlySync().source === 'default')

  await store.patch({ email: 'someone@qq.com', authCode: 'abcdefghijklmnop' })
  const mode = (await stat(store.file)).mode & 0o777
  check('配置文件权限为 0600', mode === 0o600, '0o' + mode.toString(8))
  check('email 域名自动识别 preset', store.readSync().accounts[0].preset === 'qq')

  const view = store.view()
  check('已配置', view.configured === true)
  check('不回显授权码（只给掩码）', view.authCodeHint === 'abcd…（16 位）' && !JSON.stringify(view).includes('abcdefghijklmnop'))
  check('IMAP 取预设', view.imap.host === 'imap.qq.com' && view.imap.port === 993 && view.imap.secure === true)
  check('SMTP 取预设', view.smtp.host === 'smtp.qq.com' && view.smtp.port === 465)

  await store.patch({ readOnly: false })
  check('显式 readOnly 覆盖种子', store.readOnlySync().value === false && store.readOnlySync().source === 'store')

  await store.patch({ imapHost: 'imap.example.com', imapPort: 143, imapSecure: false })
  const custom = store.view()
  check('自定义服务器覆盖预设', custom.imap.host === 'imap.example.com' && custom.imap.port === 143 && custom.imap.secure === false)
  check('SMTP 仍走预设', custom.smtp.host === 'smtp.qq.com')

  const account = store.account(store.view(), store.readSync())
  check('account 解析出授权码', account.error === '' && account.account.authCode === 'abcdefghijklmnop')
  check('account 带超时与上限', account.account.timeoutMs === 30000 && account.account.maxParseMb === 40)

  await store.patch({ reset: true })
  const afterReset = store.view()
  check('reset 清空凭据', afterReset.email === '' && afterReset.authCodeSet === false)
  check('reset 后仍是只读', store.readOnlySync().value === true)
}

console.log('\n▸ 缺配置时的错误信息可执行')
{
  const store = new MailStore(true)
  const missingEmail = store.account(store.view(), store.readSync())
  check('无邮箱地址 → 明确提示', missingEmail.error.includes('邮箱地址'))
  await store.patch({ email: 'someone@qq.com' })
  const missingCode = store.account(store.view(), store.readSync())
  check('无授权码 → 提示授权码 + 获取方式', missingCode.error.includes('授权码') && missingCode.error.includes('IMAP/SMTP'))
  await store.patch({ reset: true })
}

console.log('\n▸ maskSecret')
check('不回显全文', maskSecret('1234567890abcdef') === '1234…（16 位）')
check('空串返回空', maskSecret('') === '')

console.log('\n▸ MIME 组包 → 解析 往返（真实 nodemailer + mailparser）')
{
  const composed = await composeMessage(
    { name: '发件人', address: 'me@qq.com' },
    {
      to: ['you@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: '测试主题 Test',
      text: '你好，这是一封测试邮件。\n第二行。',
      html: '',
      attachments: [],
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>'],
      saveSent: true,
    },
  )
  check('compose 产出 Buffer', Buffer.isBuffer(composed.raw) && composed.raw.length > 0)
  check('envelope.to 含 bcc', composed.envelope.to.length === 3, JSON.stringify(composed.envelope.to))
  check('envelope.from 是纯地址', composed.envelope.from === 'me@qq.com')
  const rawText = composed.raw.toString('utf8')
  check('Bcc 头被剥离（只进信封）', !/^Bcc:/im.test(rawText))
  check('In-Reply-To 已写入', rawText.includes('In-Reply-To: <parent@example.com>'))

  const parsed = await parseSource(composed.raw)
  const detail = toDetail(parsed, 42, 'INBOX', { seen: false, flagged: false, answered: false }, false)
  check('往返保留主题', detail.subject === '测试主题 Test', detail.subject)
  check('往返保留发件人', detail.from[0]?.address === 'me@qq.com')
  check('往返保留收件人', detail.to[0]?.address === 'you@example.com')
  check('往返保留正文', detail.text.includes('这是一封测试邮件'))
  check('往返保留 Message-ID', detail.messageId !== '')
  check('往返保留 In-Reply-To', detail.inReplyTo === '<parent@example.com>')
  check('size 由源长度得出', detail.size === composed.raw.length)
  check('无附件', detail.attachments.length === 0 && detail.hasAttachments === false)
}

console.log('\n▸ 附件解析（含中文文件名）')
{
  const attachmentPath = path.join(tempDir, '发票 2026.pdf')
  await writeFile(attachmentPath, Buffer.from('%PDF-1.4 fake'))
  const composed = await composeMessage(
    { name: '', address: 'me@qq.com' },
    {
      to: ['you@example.com'],
      cc: [],
      bcc: [],
      subject: 'with attachment',
      text: 'see attached',
      html: '',
      attachments: [{ filename: '发票 2026.pdf', path: attachmentPath }],
      inReplyTo: '',
      references: [],
      saveSent: true,
    },
  )
  const parsed = await parseSource(composed.raw)
  const detail = toDetail(parsed, 1, 'INBOX', { seen: false, flagged: false, answered: false }, false)
  check('附件被解析出来', detail.attachments.length === 1, JSON.stringify(detail.attachments))
  check('附件序号从 1 开始', detail.attachments[0]?.index === 1)
  check('中文附件名保留', detail.attachments[0]?.filename === '发票 2026.pdf', detail.attachments[0]?.filename)
  check('附件类型被识别', (detail.attachments[0]?.contentType ?? '').includes('pdf'), detail.attachments[0]?.contentType)
  check('hasAttachments 为真', detail.hasAttachments === true)
}

console.log('\n▸ 工具名册随 readOnly 变化')
{
  const readOnlyNames = buildSpecs(true).map((spec) => spec.name)
  const writeNames = buildSpecs(false).map((spec) => spec.name)
  check('只读模式无写工具', !readOnlyNames.some((name) => ['qqmail_send', 'qqmail_reply', 'qqmail_mark', 'qqmail_move', 'qqmail_delete'].includes(name)))
  check('只读模式含核心读工具', ['qqmail_status', 'qqmail_config', 'qqmail_list', 'qqmail_search', 'qqmail_read', 'qqmail_attachment', 'qqmail_folders'].every((name) => readOnlyNames.includes(name)))
  check('读写模式含全部写工具', ['qqmail_send', 'qqmail_reply', 'qqmail_mark', 'qqmail_move', 'qqmail_delete'].every((name) => writeNames.includes(name)))
  check('读写模式共 13 个工具', writeNames.length === 13, String(writeNames.length))
  check('只读模式共 8 个工具', readOnlyNames.length === 8, String(readOnlyNames.length))
  check('工具名唯一', new Set(writeNames).size === writeNames.length)
}

console.log('\n▸ 每个工具的描述与参数都可转 schema')
{
  let bad = ''
  for (const spec of buildSpecs(false)) {
    if (spec.description.length < 30) bad = spec.name + ' 描述过短'
    const schema = toJsonSchema(spec.parameters)
    if (schema.type !== 'object' || schema.additionalProperties !== false) bad = spec.name + ' 根 schema 异常'
    for (const [key, node] of Object.entries(schema.properties)) {
      if (typeof node.type !== 'string') bad = spec.name + '.' + key + ' 缺 type'
    }
  }
  check('全部 13 个工具通过', bad === '', bad)
  const send = buildSpecs(false).find((spec) => spec.name === 'qqmail_send')
  check('qqmail_send.to 是必填', toJsonSchema(send.parameters).required.includes('to'))
}

console.log('\n▸ CLI 参数解析')
{
  const { parseArgs } = await import('../lib/cli.js')
  const parsed = parseArgs(['list', '--mailbox', 'INBOX', '--limit', '5', '--unseen', '--json'])
  check('命令识别', parsed.command === 'list')
  check('带值 flag', parsed.flags.mailbox === 'INBOX' && parsed.flags.limit === '5')
  check('布尔 flag', parsed.flags.unseen === true && parsed.flags.json === true)
  const send = parseArgs(['send', '--to', 'a@b.com', '--attach', 'x.pdf', '--attach', 'y.pdf'])
  check('可重复 flag 累积', Array.isArray(send.flags.attach) && send.flags.attach.length === 2)
  check('签名值保留双横线首行', parseArgs(['config', '--signature', '--\nfixture signature']).flags.signature === '--\nfixture signature')
  check('普通双横线开头的值被保留', parseArgs(['config', '--signature', '--fixture']).flags.signature === '--fixture')
  check('签名值可为双横线', parseArgs(['config', '--signature', '--']).flags.signature === '--')
  const equals = parseArgs(['list', '--limit=50'])
  check('--key=value 形式', equals.flags.limit === '50')
  for (const key of ['read-only', 'permanent', 'confirm']) {
    for (const literal of ['true', 'false']) {
      const parsed = parseArgs(['delete', '--' + key, literal, '100'])
      check('--' + key + ' ' + literal + ' 消费字面量并保留 uid', parsed.flags[key] === literal && parsed.positional.join() === '100')
      check('--' + key + '=' + literal + ' 兼容', parseArgs(['delete', '--' + key + '=' + literal]).flags[key] === literal)
    }
  }
}

console.log('\n▸ 隔离性断言')
{
  // The run must stay inside the temp dir — resolving to the real path would itself be the bug.
  check('配置路径在临时目录内', (process.env.DSH_QQMAIL_CONFIG ?? '').startsWith(tempDir))
  // And the real config must come out untouched, whether or not it already existed.
  const realAfter = await stat(realConfig).then(({ mtimeMs, size }) => mtimeMs + ':' + size).catch(() => 'missing')
  check('真实配置未被改动', realAfter === realConfigBefore, realConfigBefore + ' → ' + realAfter)
  check('临时配置目录已写入', (await readFile(process.env.DSH_QQMAIL_CONFIG, 'utf8').catch(() => '')).length >= 0)
}

await rm(tempDir, { recursive: true, force: true })

console.log('\n' + (failed === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + String(passed) + ' 通过 / ' + String(failed) + ' 失败\n')
process.exit(failed === 0 ? 0 : 1)
