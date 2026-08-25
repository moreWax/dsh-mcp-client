/**
 * Tool bridge: discovers MCP tools, registers them on the harness ToolRuntime
 * under deterministic server-qualified public names, and handles re-sync when
 * the server's tool list changes.
 *
 * Naming contract (see the mcp-client Agent Note "Naming invariants"): every MCP tool
 * has the stable identity `(serverName, rawName)`; the model-facing public name
 * is `mcp__<serverName>__<rawName>`, normalized to the DeepSeek function-name
 * constraints. The raw name is only ever sent on the wire (`tools/call`); the
 * public name is never parsed to recover it.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { ListToolsResultSchema } from '@modelcontextprotocol/core'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonSchemaNode, JsonValue } from '@deepseek-ai/dsh-tools'
import { createDefinition, supportedOutputSchema } from './tool-definition.js'
import { ToolRegistrationGeneration } from './tool-registrations.js'
export type { ToolDisposers } from './tool-registrations.js'
import type { ToolDisposers } from './tool-registrations.js'

/** Resolved options relevant to tool bridging. */
export interface ToolBridgeOptions {
  /** Whether a registry conflict is contained or rejects this synchronization. */
  registrationFailure: 'contain' | 'throw'
  serverName: string
  toolCallTimeoutMs: number
}

/** Canonical MCP result exposed to Code Mode without discarding protocol blocks. */
export type McpResult<Structured extends JsonValue = JsonValue> = {
  content: JsonValue[]
  structuredContent?: Structured
}

/**
 * DeepSeek function-name contract: at most 64 characters. Wire-protocol
 * constant, not configuration.
 */
const MAX_PUBLIC_NAME_LENGTH = 64

/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g

/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12

/** List without mutating the SDK's per-page output-validator cache. */
function listToolsUncached(client: Client, cursor?: string) {
  return client.request(
    { method: 'tools/list', ...cursor === undefined ? {} : { params: { cursor } } },
    ListToolsResultSchema,
  )
}

/**
 * Derive the model-facing public name for one MCP tool.
 *
 * Deterministic pure function of `(serverName, rawName)`: the clean case is
 * `mcp__<serverName>__<rawName>` verbatim. When character replacement or
 * truncation to the DeepSeek function-name contract (64 chars,
 * `[A-Za-z0-9_-]`) changes the name, a 12-hex-char SHA-256 hash of the
 * identity is appended so distinct MCP identities never collapse into the
 * same public name.
 *
 * @param serverName - Stable local namespace from plugin config.
 * @param rawName - The MCP server's own tool name.
 * @returns The globally unique, model-facing ToolRuntime name.
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/**
 * Sync the MCP server's tool list into the harness ToolRuntime.
 *
 * Two phases keep the swap safe:
 *
 * 1. Fetch: drain uncached `tools/list` pagination and build the full next
 *    generation of `ToolDefinition`s under public names. Any failure here
 *    (network error, duplicate raw name in the server's list) rejects and
 *    leaves the previous generation registered untouched.
 * 2. Swap: dispose the previous generation, register the new one. A registry
 *    conflict here can only mean a foreign registration squats on this
 *    server's `mcp__<serverName>__` namespace — the partial generation is
 *    rolled back (zero tools from this server) and logged. Initial strict
 *    synchronization may propagate the conflict so its parent transaction
 *    rejects; ordinary clients and later re-syncs return an empty map.
 *
 * @param client - Connected MCP Client instance used to list and call tools.
 * @param ctx - Cordis context providing the `tools` service for registration.
 * @param opts - Bridge options: server namespace and per-call timeout.
 * @param previous - Disposer map from the prior sync generation; disposed
 *   during the swap phase (only after the fetch phase succeeded).
 * @returns A map of registered public tool names to their unregister
 *   disposers — the exact set of live registrations owned by this server.
 */
class ToolRegistrySynchronizer {
  constructor(private readonly client: Client, private readonly ctx: Context, private readonly opts: ToolBridgeOptions) {}

  async synchronize(previous: ToolDisposers): Promise<ToolDisposers> {
    const definitions = await this.fetchDefinitions()
    new ToolRegistrationGeneration(previous).dispose()
    try { return ToolRegistrationGeneration.register(this.ctx, definitions).toMap() }
    catch (error) {
      this.ctx.logger.error(`mcp-client(${this.opts.serverName}): tool registration failed, no tools registered: ${String(error)}`)
      if (this.opts.registrationFailure === 'throw') throw error
      return new Map()
    }
  }

  private async fetchDefinitions(): Promise<Map<string, ToolDefinition>> {
    const definitions = new Map<string, ToolDefinition>()
    let cursor: string | undefined
    do {
      const response = await listToolsUncached(this.client, cursor)
      for (const tool of response.tools) {
        const publicName = publicToolName(this.opts.serverName, tool.name)
        if (definitions.has(publicName)) throw new Error(`mcp-client(${this.opts.serverName}): server listed tool "${tool.name}" more than once — invalid tool list`)
        definitions.set(publicName, createDefinition({
          client: this.client, ctx: this.ctx, publicName, rawName: tool.name,
          description: tool.description ?? '', parameters: tool.inputSchema,
          structuredSchema: supportedOutputSchema(tool.outputSchema),
          taskRequired: tool.execution?.taskSupport === 'required', opts: this.opts,
        }))
      }
      cursor = response.nextCursor
    } while (cursor)
    return definitions
  }
}

export function syncTools(client: Client, ctx: Context, opts: ToolBridgeOptions, previous: ToolDisposers): Promise<ToolDisposers> {
  return new ToolRegistrySynchronizer(client, ctx, opts).synchronize(previous)
}
