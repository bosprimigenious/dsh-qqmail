/**
 * dsh-qqmail — MCP stdio server (`qqmail-mcp`).
 *
 * Lets agents that cannot host a DSH plugin (Claude Code, Codex, any MCP
 * client) use the very same mailbox: the tool schemas come from the same specs
 * and the credentials from the same `<DSH_HOME>/dsh-qqmail.json`, so a mailbox
 * configured once in the DSH settings panel works everywhere.
 *
 * Protocol safety: **stdout belongs to the transport**. Every diagnostic goes to
 * stderr — a stray `console.log` corrupts the JSON-RPC stream and the client
 * reports a protocol error with no hint about the cause.
 *
 * Write tools follow the configured `readOnly` switch (default: read-only). Pass
 * `--allow-write` to expose them regardless.
 */

import process from 'node:process'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import { MailService } from './mail.ts'
import { toJsonSchema } from './core/schema.ts'
import { buildSpecs, type SpecContext, type ToolSpec } from './specs.ts'
import { MailStore } from './store.ts'

/** Human-facing name reported to the MCP client. */
export const SERVER_NAME = 'dsh-qqmail'

/** Version reported to the MCP client. */
export const SERVER_VERSION = '0.1.0'

/** Write a diagnostic line without ever touching stdout. */
function log(message: string): void {
  process.stderr.write('[dsh-qqmail] ' + message + '\n')
}

/**
 * Start the stdio server and keep it running until the client disconnects.
 * @param argv - process arguments (only `--allow-write` is honoured).
 */
export async function runMcpServer(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const store = new MailStore(true)
  const allowWrite = argv.includes('--allow-write')
  const readOnly = allowWrite ? false : store.readOnlySync().value
  const service = new MailService(store)
  const specs = buildSpecs(readOnly)
  const byName = new Map<string, ToolSpec>(specs.map((spec) => [spec.name, spec]))
  const context: SpecContext = {
    service,
    store,
    workspaceDir: process.cwd(),
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: specs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: toJsonSchema(spec.parameters),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const spec = byName.get(name)
    if (spec === undefined) {
      return {
        content: [{ type: 'text' as const, text: '未知工具：' + name }],
        isError: true,
      }
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>
    try {
      const result = await spec.handler(args, context)
      return {
        content: [{ type: 'text' as const, text: result.message }],
        isError: !result.ok,
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }
    }
  })

  const shutdown = (): void => {
    void service.closeAll().finally(() => {
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(
    'MCP stdio server ready（' +
      String(specs.length) +
      ' 个工具，' +
      (readOnly ? '只读模式；用 --allow-write 或把配置的 readOnly 设为 false 开放写工具' : '读写模式') +
      '）',
  )
}

/** Self-execute when run as the entry point (never when imported). */
const invokedDirectly = (() => {
  const entry = process.argv[1] ?? ''
  return /(^|[/\\])mcp-server\.(js|ts|mjs)$/.test(entry)
})()

if (invokedDirectly) {
  runMcpServer().catch((error: unknown) => {
    log('启动失败：' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
