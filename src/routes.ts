/**
 * dsh-qqmail — loopback HTTP routes for the web panel.
 *
 * Route family: /api/dsh-qqmail/*. Every route is loopback-only
 * (127.0.0.1 / ::1, same-origin), matching the other dsh-* panels.
 *
 * The panel deliberately drives the *same* ToolSpec handlers the agent calls:
 * an earlier plugin in this family hand-wired a thinner subset for its panel and
 * the two surfaces drifted apart. Here a fix in a spec fixes both.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { MailService } from './mail.ts'
import { PRESET_IDS, PRESETS } from './core/presets.ts'
import { allSpecs, type SpecContext, type SpecResult } from './specs.ts'
import type { MailStore } from './store.ts'

/** Route paths. */
export const QQMAIL_API = {
  status: '/api/dsh-qqmail/status',
  config: '/api/dsh-qqmail/config',
  probe: '/api/dsh-qqmail/probe',
  folders: '/api/dsh-qqmail/folders',
  list: '/api/dsh-qqmail/list',
  search: '/api/dsh-qqmail/search',
  read: '/api/dsh-qqmail/read',
  mark: '/api/dsh-qqmail/mark',
  send: '/api/dsh-qqmail/send',
} as const

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 256 * 1024

/** Strict loopback fence for every route (the panel is same-origin only). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
    return false
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

/** Read and parse a JSON request body (undefined when invalid). */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Convert query-string parameters into spec arguments with real types. */
function queryArgs(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of params.entries()) {
    if (key === 'uids') {
      out.uids = value
        .split(',')
        .map((entry) => Number(entry.trim()))
        .filter((entry) => Number.isFinite(entry))
      continue
    }
    if (value === 'true') {
      out[key] = true
      continue
    }
    if (value === 'false') {
      out[key] = false
      continue
    }
    if (/^-?\d+(\.\d+)?$/.test(value)) {
      out[key] = Number(value)
      continue
    }
    out[key] = value
  }
  return out
}

/** Route dependencies. */
export interface RouteContext {
  store: MailStore
  service: MailService
  /** Directory attachments land in when no downloadDir is configured. */
  workspaceDir: string
  onConfigChanged?: () => void
}

/** Build the route list for ctx.webServer.register. */
export function makeRoutes(deps: RouteContext) {
  const { store, service } = deps
  const specContext: SpecContext = {
    service,
    store,
    workspaceDir: deps.workspaceDir,
    ...(deps.onConfigChanged !== undefined ? { onConfigChanged: deps.onConfigChanged } : {}),
  }
  const byName = new Map(allSpecs().map((spec) => [spec.name, spec]))

  /** Run one spec by name, always resolving to a payload (never throwing). */
  const run = async (name: string, args: Record<string, unknown>): Promise<SpecResult> => {
    const spec = byName.get(name)
    if (spec === undefined) return { ok: false, message: '未知工具：' + name }
    try {
      return await spec.handler(args, specContext)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: 'method not allowed: ' + String(req.method) })
      return false
    }
    return true
  }

  return [
    {
      kind: 'exact' as const,
      path: QQMAIL_API.status,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        const result = await run('qqmail_status', { probe: params.get('probe') === '1' })
        // The panel needs the preset catalogue to render its provider picker;
        // the agent gets it from the tool description instead.
        writeJson(res, 200, {
          ...result,
          presets: PRESET_IDS.map((id) => ({
            id,
            label: PRESETS[id].label,
            imap: PRESETS[id].imap,
            smtp: PRESETS[id].smtp,
            credentialHint: PRESETS[id].credentialHint,
          })),
          readOnly: store.readOnlySync().value,
        })
      },
    },
    {
      kind: 'exact' as const,
      path: QQMAIL_API.config,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          writeJson(res, 200, await run('qqmail_config', {}))
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          writeJson(res, 200, await run('qqmail_config', body))
          return
        }
        writeJson(res, 405, { error: 'method not allowed: ' + method })
      },
    },
    {
      kind: 'exact' as const,
      path: QQMAIL_API.probe,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        writeJson(res, 200, await run('qqmail_status', { probe: true }))
      },
    },
    {
      kind: 'exact' as const,
      path: QQMAIL_API.folders,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        writeJson(res, 200, await run('qqmail_folders', { status: params.get('status') !== '0' }))
      },
    },
    {
      kind: 'exact' as const,
      path: QQMAIL_API.list,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        writeJson(res, 200, await run('qqmail_list', queryArgs(params)))
      },
    },
    {
      kind: 'exact' as const,
      path: QQMAIL_API.search,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        const keyword = (params.get('q') ?? '').trim()
        const args = queryArgs(params)
        if (keyword !== '') args.text = keyword
        writeJson(res, 200, await run('qqmail_search', args))
      },
    },
    {
      kind: 'exact' as const,
      path: QQMAIL_API.read,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        writeJson(res, 200, await run('qqmail_read', queryArgs(params)))
      },
    },
    {
      kind: 'exact' as const,
      path: QQMAIL_API.mark,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        writeJson(res, 200, await run('qqmail_mark', body))
      },
    },
    {
      kind: 'exact' as const,
      path: QQMAIL_API.send,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        writeJson(res, 200, await run('qqmail_send', body))
      },
    },
  ]
}
