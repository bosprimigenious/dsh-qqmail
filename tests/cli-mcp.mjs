/**
 * dsh-qqmail CLI + MCP entry tests.
 *
 * Runs the two non-plugin surfaces as real child processes against the fake
 * servers, because those two are what a *different* agent (Claude Code, Codex, a
 * shell script) will actually call — an in-process import would not prove that
 * the shebang, the bundled entry point and the stdio protocol framing work.
 *
 * stdout discipline matters for the MCP half: the transport owns stdout, so this
 * test asserts that nothing but JSON-RPC ever shows up there.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)
const USER = 'me@qq.com'
const CODE = 'auth-code-16chars'

const tempDir = await mkdtemp(path.join(tmpdir(), 'dsh-qqmail-cli-'))
const configPath = path.join(tempDir, 'dsh-qqmail.json')

/** Spawn one CLI run and collect its output. */
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'lib', 'cli.js'), ...args], {
      env: { ...process.env, DSH_QQMAIL_CONFIG: configPath, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

let imap = null
let smtp = null

try {
  console.log('\n▸ 准备：假服务器 + 临时配置')
  const rawMail = Buffer.from(
    [
      'From: =?UTF-8?B?5byg5LiJ?= <zhangsan@example.com>',
      'To: me@qq.com',
      'Date: Mon, 01 Sep 2026 10:00:00 +0800',
      'Subject: alpha invoice',
      'Message-ID: <cli-1@example.com>',
      '',
      'cli body with alpha keyword',
      '',
    ].join('\r\n'),
    'utf8',
  )
  imap = await startFakeImap({ user: USER, password: CODE, messages: { INBOX: [{ uid: 1, raw: rawMail }] } })
  smtp = await startFakeSmtp()
  await writeFile(
    configPath,
    JSON.stringify(
      {
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
        signature: 'CLI 签名',
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
  check('临时配置就绪', true)

  console.log('\n▸ CLI：帮助与状态')
  {
    const help = await runCli(['help'])
    check('help 退出码 0', help.code === 0, String(help.code))
    check('help 列出命令', help.stdout.includes('qqmail read') && help.stdout.includes('qqmail send'))
    const status = await runCli(['status', '--json'])
    check('status 退出码 0', status.code === 0, status.stderr)
    const payload = JSON.parse(status.stdout)
    check('status 报 ok', payload.ok === true)
    check('status 不回显授权码', !status.stdout.includes(CODE))
    check('status 带掩码提示', payload.data.authCodeHint.includes('auth'), payload.data.authCodeHint)
  }

  console.log('\n▸ CLI：文件夹与列表')
  {
    const folders = await runCli(['folders', '--json'])
    const payload = JSON.parse(folders.stdout)
    check('列出文件夹', (payload.data.mailboxes ?? []).some((entry) => entry.path === 'INBOX'), folders.stdout.slice(0, 200))
    const list = await runCli(['list', '--limit', '5', '--json'])
    const listed = JSON.parse(list.stdout)
    check('列表返回 1 封', listed.data.items.length === 1, list.stdout.slice(0, 200))
    check('主题解析', listed.data.items[0].subject === 'alpha invoice', listed.data.items[0].subject)
    check('中文发件人名解码', listed.data.items[0].from[0].name === '张三', listed.data.items[0].from[0].name)
  }

  console.log('\n▸ CLI：读邮件与搜索')
  {
    const read = await runCli(['read', '1', '--json'])
    const payload = JSON.parse(read.stdout)
    check('读到正文', payload.data.items[0].text.includes('alpha keyword'), read.stdout.slice(0, 200))
    const search = await runCli(['search', 'alpha', '--json'])
    const found = JSON.parse(search.stdout)
    check('搜索命中', found.data.items.length === 1, search.stdout.slice(0, 200))
    check('搜索标明 mode', found.data.mode === 'server', found.data.mode)
  }

  console.log('\n▸ CLI：发信（真实 SMTP）')
  {
    const before = smtp.messages.length
    const send = await runCli(['send', '--to', 'dest@example.com', '--subject', 'CLI 发出的邮件', '--text', '来自命令行的正文'])
    check('send 退出码 0', send.code === 0, send.stderr)
    check('stdout 报告已发送', send.stdout.includes('已发送'), send.stdout.slice(0, 200))
    check('SMTP 收到', smtp.messages.length === before + 1)
    const delivered = smtp.messages[smtp.messages.length - 1] ?? ''
    check('主题被 MIME 编码', /=\?UTF-8\?/i.test(delivered))
    check('存副本到已发送', imap.appended.length >= 1)
  }

  console.log('\n▸ CLI：错误路径')
  {
    const bad = await runCli(['read'])
    check('缺参数给出用法', bad.code === 2 && bad.stderr.includes('用法'), bad.stderr.trim())
    const unknown = await runCli(['nope'])
    check('未知命令退出码 2', unknown.code === 2)
    const noConfig = await runCli(['status', '--json'], { DSH_QQMAIL_CONFIG: path.join(tempDir, 'missing.json') })
    const payload = JSON.parse(noConfig.stdout)
    check('未配置也能读状态', payload.ok === true && payload.data.configured === false, noConfig.stdout.slice(0, 160))
  }

  console.log('\n▸ MCP：stdio 协议')
  {
    const mcp = spawn(process.execPath, [path.join(root, 'lib', 'mcp-server.js'), '--allow-write'], {
      env: { ...process.env, DSH_QQMAIL_CONFIG: configPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const responses = []
    let stdoutBuffer = ''
    let stderr = ''
    mcp.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8')
      let newline = stdoutBuffer.indexOf('\n')
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line !== '') {
          try {
            responses.push(JSON.parse(line))
          } catch {
            responses.push({ parseError: line })
          }
        }
        newline = stdoutBuffer.indexOf('\n')
      }
    })
    mcp.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })

    const sendRpc = (message) => mcp.stdin.write(JSON.stringify(message) + '\n')
    const waitFor = async (predicate, timeoutMs = 20000) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = responses.find(predicate)
        if (found !== undefined) return found
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return undefined
    }

    sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    })
    const init = await waitFor((entry) => entry.id === 1)
    check('initialize 有响应', init !== undefined, stderr.trim())
    check('声明 tools 能力', init?.result?.capabilities?.tools !== undefined, JSON.stringify(init?.result?.capabilities))
    check('serverInfo 名称正确', init?.result?.serverInfo?.name === 'dsh-qqmail', JSON.stringify(init?.result?.serverInfo))

    sendRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    sendRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const list = await waitFor((entry) => entry.id === 2)
    const tools = list?.result?.tools ?? []
    check('列出 13 个工具（--allow-write）', tools.length === 13, String(tools.length))
    check('工具名带 qqmail_ 前缀', tools.every((tool) => tool.name.startsWith('qqmail_')))
    check('每个工具有描述', tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 20))
    const sendTool = tools.find((tool) => tool.name === 'qqmail_send')
    check('qqmail_send 是标准 JSON Schema', sendTool?.inputSchema?.type === 'object' && Array.isArray(sendTool.inputSchema.required), JSON.stringify(sendTool?.inputSchema)?.slice(0, 200))
    check('qqmail_send.to 必填', (sendTool?.inputSchema?.required ?? []).includes('to'))

    sendRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qqmail_folders', arguments: {} } })
    const call = await waitFor((entry) => entry.id === 3)
    check('tools/call 有响应', call !== undefined)
    const text = call?.result?.content?.[0]?.text ?? ''
    check('返回文件夹文本', text.includes('INBOX'), text.slice(0, 160))
    check('未标记为错误', call?.result?.isError !== true)

    sendRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'qqmail_read', arguments: { uid: 1 } } })
    const read = await waitFor((entry) => entry.id === 4)
    check('读邮件返回正文', (read?.result?.content?.[0]?.text ?? '').includes('alpha keyword'))

    sendRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'qqmail_nope', arguments: {} } })
    const missing = await waitFor((entry) => entry.id === 5)
    check('未知工具报错', missing?.result?.isError === true, JSON.stringify(missing?.result)?.slice(0, 160))

    check('stdout 全是合法 JSON-RPC', responses.every((entry) => entry.parseError === undefined || false))
    check('诊断信息走 stderr 而非 stdout', stderr.includes('[dsh-qqmail]'), stderr.slice(0, 160))
    mcp.kill('SIGTERM')
    await new Promise((resolve) => mcp.on('close', resolve))
  }
} catch (error) {
  failed++
  console.error('\n✘ 运行中断：' + (error instanceof Error ? error.stack : String(error)))
} finally {
  if (imap !== null) await imap.close().catch(() => undefined)
  if (smtp !== null) await smtp.close().catch(() => undefined)
  await rm(tempDir, { recursive: true, force: true })
}

console.log('\n' + (failed === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + String(passed) + ' 通过 / ' + String(failed) + ' 失败\n')
process.exit(failed === 0 ? 0 : 1)
