/**
 * dsh-qqmail — parameter spec → JSON Schema.
 *
 * The agent tools declare parameters with the harness DSL: an implicit open
 * object root whose properties carry `required: true`. The host half hands that
 * spec straight to `defineTool`, which compiles it itself.
 *
 * The MCP stdio server cannot do that: it is launched by *other* agents
 * (`npx -y @zhengjunyao/dsh-qqmail qqmail-mcp`, Claude Code, Codex, …) where the
 * `@deepseek-ai/*` packages are not installed at all, so it must not import
 * them. This module therefore declares a structurally compatible subset of that
 * DSL and converts it into plain JSON Schema — which is what lets one tool
 * definition feed all three surfaces.
 */

/** Annotations shared by every parameter node. */
export interface ParamAnnotations {
  description?: string
  /** Marked properties become the JSON Schema `required` list. */
  required?: true
}

/**
 * One author-facing parameter property.
 *
 * Deliberately mirrors the harness `ValueSchemaSpec` variants (a required `type`
 * discriminator, optional `enum`, `items` for arrays) so the very same object
 * literal satisfies both `defineTool` and {@link toJsonSchema}.
 */
export type ParamProperty = ParamAnnotations &
  (
    | { type: 'string'; enum?: readonly string[] }
    | { type: 'number'; enum?: readonly number[] }
    | { type: 'integer' }
    | { type: 'boolean' }
    | { type: 'null' }
    | { type: 'array'; items?: ParamProperty }
    | { type: 'object'; properties?: ParamSpec; additionalProperties: boolean }
    /** Unconstrained lossless JSON. */
    | { type: 'json' }
  )

/** Implicit parameter-root property map. */
export type ParamSpec = Record<string, ParamProperty>

/** Plain JSON Schema object accepted by the MCP SDK. */
export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, Record<string, unknown>>
  required: string[]
  additionalProperties: false
}

/** Convert one value node. */
function convertNode(node: ParamProperty): Record<string, unknown> {
  const out: Record<string, unknown> = { type: node.type }
  if (node.description !== undefined) out.description = node.description
  if ('enum' in node && node.enum !== undefined) out.enum = [...node.enum]
  if (node.type === 'array') {
    out.items = node.items !== undefined ? convertNode(node.items) : { type: 'string' }
  }
  if (node.type === 'object') {
    out.properties = 'properties' in node && node.properties !== undefined ? toJsonSchema(node.properties).properties : {}
    out.additionalProperties = 'additionalProperties' in node ? node.additionalProperties : false
  }
  return out
}

/**
 * Project the parameter spec onto standard JSON Schema.
 * @param spec - the tool's parameter map.
 * @returns an object schema with `required` derived from `required: true`.
 */
export function toJsonSchema(spec: ParamSpec): JsonSchemaObject {
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const [key, node] of Object.entries(spec)) {
    properties[key] = convertNode(node)
    if (node.required === true) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Names of the required properties in a spec (used by docs and tests). */
export function requiredKeys(spec: ParamSpec): string[] {
  return Object.entries(spec)
    .filter(([, node]) => node.required === true)
    .map(([key]) => key)
}
