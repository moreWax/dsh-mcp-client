/** Shared test doubles: harness ToolRuntime + logger, mounted on a real Cordis Context. */
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

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
export function fakeExec(): { signal: AbortSignal } {
  return { signal: new AbortController().signal }
}

export const ECHO_SERVER = new URL('./fixtures/echo-server.mjs', import.meta.url).pathname

export function stdioConfig(serverName: string, overrides: Record<string, unknown> = {}) {
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
