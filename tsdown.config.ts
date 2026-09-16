/**
 * dsh-qqmail build config: node-half lib bundle (host plugin + CLI + MCP stdio
 * server) plus the browser client bundle (lib/client.js — the closure-factory
 * artifact for the GUI's __ModuleLoader__, served at /plugins/dsh-qqmail/client.js).
 */
import { clientBundle } from './shared/tsdown.client.ts'

export default clientBundle(
  '@zhengjunyao/dsh-qqmail',
  ['src/index.ts', 'src/cli.ts', 'src/mcp-server.ts'],
  {
    libExternal: [
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-llm',
    ],
  },
)
