/**
 * End-to-end against a real MCP server over stdio (v2 server SDK fixture):
 * connect, tool discovery, execution, error mapping, and disposal.
 */
import { describe, expect, it } from 'vitest'
import type { ToolRunContext, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { startConnection, resolveReconnectPolicy } from '../src/connection.js'
import type { Config } from '../src/index.js'
import { makeCtx, fakeExec, stdioConfig } from './helpers.js'

const POLICY = resolveReconnectPolicy({ enabled: false }, 'test')

async function connect(config: Config) {
  const { ctx, tools, logs } = makeCtx()
  const handle = startConnection(ctx, config, POLICY)
  const outcome = await handle.ready
  return { ctx, tools, logs, handle, outcome }
}

function getTool(tools: { registered: Map<string, ToolDefinition> }, name: string): ToolDefinition {
  const def = tools.registered.get(name)
  if (def === undefined) throw new Error(`tool not registered: ${name}`)
  return def
}

describe('stdio e2e', () => {
  it('connects and registers server tools under public names', async () => {
    const { tools, handle, outcome } = await connect(stdioConfig('test') as Config)
    expect(outcome.error).toBeUndefined()
    expect([...tools.registered.keys()].sort()).toEqual([
      'mcp__test__add',
      'mcp__test__echo',
      'mcp__test__fail',
    ])
    await handle.dispose()
  })

  it('executes a text tool and returns the canonical MCP result', async () => {
    const { tools, handle } = await connect(stdioConfig('test') as Config)
    const echo = getTool(tools, 'mcp__test__echo')
    const result = await echo.execute(
      { text: 'hello' },
      fakeExec() as unknown as ToolRunContext,
    ) as { content: Array<{ type: string; text?: string }> }
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo: hello' })
    await handle.dispose()
  })

  it('returns structuredContent when the server provides it', async () => {
    const { tools, handle } = await connect(stdioConfig('test') as Config)
    const add = getTool(tools, 'mcp__test__add')
    const result = await add.execute(
      { a: 2, b: 3 },
      fakeExec() as unknown as ToolRunContext,
    ) as { structuredContent?: { sum: number } }
    expect(result.structuredContent).toEqual({ sum: 5 })
    await handle.dispose()
  })

  it('throws on MCP isError results so the runtime produces an error for the model', async () => {
    const { tools, handle } = await connect(stdioConfig('test') as Config)
    const fail = getTool(tools, 'mcp__test__fail')
    await expect(
      fail.execute({}, fakeExec() as unknown as ToolRunContext),
    ).rejects.toThrow('fixture failure')
    await handle.dispose()
  })

  it('reports the real error on a failed initial connection', async () => {
    const { handle, outcome } = await connect(stdioConfig('bad', {
      command: '/nonexistent/mcp-server-binary',
    }) as Config)
    expect(outcome.error).toBeDefined()
    await handle.dispose()
  })

  it('dispose unregisters every tool the server owned', async () => {
    const { tools, handle } = await connect(stdioConfig('test') as Config)
    expect(tools.registered.size).toBe(3)
    await handle.dispose()
    expect(tools.registered.size).toBe(0)
  })
})
