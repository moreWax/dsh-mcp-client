/**
 * End-to-end against a real MCP server over stdio (v2 server SDK fixture):
 * connect, tool discovery, execution, error mapping, and disposal.
 */
import { describe, expect, it, onTestFinished } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { startConnection, resolveReconnectPolicy } from '../src/connection.js'
import type { Config } from '../src/index.js'
import { makeCtx, fakeExec, stdioConfig } from './helpers.js'

const POLICY = resolveReconnectPolicy({ enabled: false }, 'test')

async function connect(config: Config) {
  const { ctx, tools, logs } = makeCtx()
  const handle = startConnection(ctx, config, POLICY)
  onTestFinished(async () => { await handle.dispose() })
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
    const { tools, outcome } = await connect(stdioConfig('test'))
    expect(outcome.error).toBeUndefined()
    expect([...tools.registered.keys()].sort()).toEqual([
      'mcp__test__add',
      'mcp__test__echo',
      'mcp__test__fail',
    ])
  })

  it('executes a text tool and returns the canonical MCP result', async () => {
    const { tools } = await connect(stdioConfig('test'))
    const echo = getTool(tools, 'mcp__test__echo')
    const result = await echo.execute(
      { text: 'hello' },
      fakeExec(),
    ) as { content: Array<{ type: string; text?: string }> }
    expect(result.content[0]).toEqual({ type: 'text', text: 'echo: hello' })
  })

  it('returns structuredContent when the server provides it', async () => {
    const { tools } = await connect(stdioConfig('test'))
    const add = getTool(tools, 'mcp__test__add')
    const result = await add.execute(
      { a: 2, b: 3 },
      fakeExec(),
    ) as { structuredContent?: { sum: number } }
    expect(result.structuredContent).toEqual({ sum: 5 })
  })

  it('throws on MCP isError results so the runtime produces an error for the model', async () => {
    const { tools } = await connect(stdioConfig('test'))
    const fail = getTool(tools, 'mcp__test__fail')
    await expect(
      fail.execute({}, fakeExec()),
    ).rejects.toThrow('fixture failure')
  })

  it('reports the real error on a failed initial connection', async () => {
    const { outcome } = await connect(stdioConfig('bad', {
      command: '/nonexistent/mcp-server-binary',
    }))
    expect(outcome.error).toBeDefined()
  })

  it('dispose unregisters every tool the server owned', async () => {
    const { tools, handle } = await connect(stdioConfig('test'))
    expect(tools.registered.size).toBe(3)
    await handle.dispose()
    expect(tools.registered.size).toBe(0)
  })
})
