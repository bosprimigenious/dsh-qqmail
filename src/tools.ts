/**
 * dsh-qqmail — host-side tool wrappers.
 *
 * Turns each {@link ToolSpec} into a harness `ToolDefinition`. The specs carry
 * the whole behaviour (arguments, validation, message text), so this file only
 * supplies the harness-specific bits: the canonical output contract and the
 * model-facing renderer.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { buildSpecs, type SpecContext, type ToolSpec, type SpecResult } from './specs.ts'

/**
 * The one output contract every qqmail tool shares.
 *
 * `data` uses the author-DSL `json` node, which the harness treats as
 * unconstrained lossless JSON: the structured payload can grow (a new field on a
 * message summary, a new count in a status probe) without a schema migration,
 * while `ok`/`message` stay strictly typed for the model.
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    message: { type: 'string', required: true },
    data: { type: 'json' },
  },
} as const

/** The model sees exactly the human-readable message the spec produced. */
function renderMessage(_args: unknown, value: { message?: unknown }): ContentBlock[] {
  return [{ type: 'text', text: String(value.message ?? '') }]
}

/**
 * Recursively drop `undefined` members.
 *
 * The harness enforces the output schema against the *lossless JSON* projection
 * of the canonical value, and an `undefined` object member is not lossless JSON.
 * A spec is free to build its payload with optional fields (which is exactly what
 * spreading a partial result object does), so the cleanup happens once here
 * instead of at every call site.
 */
export function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((entry) => jsonSafe(entry)).filter((entry) => entry !== undefined)
  }
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const cleaned = jsonSafe(entry)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

/** Wrap one spec as a harness tool. */
function toTool(spec: ToolSpec, ctx: SpecContext): ToolDefinition {
  return defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderMessage,
    },
    async execute(args: unknown) {
      const result: SpecResult = await spec.handler((args ?? {}) as Record<string, unknown>, ctx)
      const payload: Record<string, unknown> = {
        ok: result.ok,
        message: result.message,
      }
      const data = jsonSafe(result.data)
      if (data !== undefined) payload.data = data
      // The harness validates this value against OUTPUT_SCHEMA at runtime; the
      // assertion only bridges the author-DSL inference to the concrete shape.
      return payload as never
    },
  })
}

/** Build every tool for the current mode. */
export function buildTools(ctx: SpecContext, readOnly: boolean): ToolDefinition[] {
  return buildSpecs(readOnly).map((spec) => toTool(spec, ctx))
}

export { WRITE_TOOL_NAMES, type SpecContext, type SpecResult, type ToolSpec } from './specs.ts'
