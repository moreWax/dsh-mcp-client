/** Shared test doubles: harness ToolRuntime + logger, mounted on a real Cordis Context. */
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { StdioConfig } from '../src/config.js'

export interface ToolsDouble {
  registered: Map<string, ToolDefinition>
  register(def: ToolDefinition): () => void
}

export function makeToolsDouble(): ToolsDouble {
  const registered = new Map<string, ToolDefinition>()
  return {
    registered,
    register(def: ToolDefinition) {
      if (registered.has(def.name)) throw new Error(`duplicate tool registration: ${def.name}`)
      registered.set(def.name, def)
      return () => { registered.delete(def.name) }
    },
  }
}

export interface LogCapture { infos: string[]; warns: string[]; errors: string[] }

export function makeCtx(): { ctx: Context; tools: ToolsDouble; logs: LogCapture } {
  const ctx = new Context()
  const tools = makeToolsDouble()
  const logs: LogCapture = { infos: [], warns: [], errors: [] }
  const bag = ctx as unknown as Record<string, unknown>
  bag.tools = tools
  bag.logger = {
    info: (m: string) => { logs.infos.push(m) },
    warn: (m: string) => { logs.warns.push(m) },
    error: (m: string) => { logs.errors.push(m) },
    debug: () => {},
  }
  return { ctx, tools, logs }
}

/** Minimal ToolExecution stand-in: the bridge only reads `signal` on non-image paths. */
export function fakeExec(): ToolRunContext {
  return { signal: new AbortController().signal } as ToolRunContext
}

export function requireTool(tools: ToolsDouble, name: string): ToolDefinition {
  const tool = tools.registered.get(name)
  if (tool === undefined) throw new Error(`missing test tool ${name}`)
  return tool
}

export const ECHO_SERVER = new URL('./fixtures/echo-server.mjs', import.meta.url).pathname

export function stdioConfig(serverName: string, overrides: Partial<StdioConfig> = {}): StdioConfig {
  return {
    transport: 'stdio' as const,
    serverName,
    command: process.execPath,
    args: [ECHO_SERVER],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 10_000,
    failOnStartupError: false,
    ...overrides,
  }
}
