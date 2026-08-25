/**
 * The flagship modern-era proof: a v2 Streamable HTTP MCP server in-process,
 * the plugin connecting over streamable-http, tools flowing both ways.
 * In the 2026-07-28 era this entire exchange is stateless — no session id,
 * every request self-describing — negotiated automatically at connect.
 */
import { createServer } from 'node:http'
import type { Server as HttpServer } from 'node:http'
import { describe, expect, it, afterEach } from 'vitest'
import type { ToolRunContext, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { McpServer } from '@modelcontextprotocol/server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { startConnection, resolveReconnectPolicy } from '../src/connection.js'
import type { Config } from '../src/index.js'
import { makeCtx, fakeExec } from './helpers.js'

const POLICY = resolveReconnectPolicy({ enabled: false }, 'test')

let http: HttpServer | undefined
afterEach(async () => {
  if (http !== undefined) {
    await new Promise<void>((resolve) => { http?.close(() => { resolve() }) })
    http = undefined
  }
})

async function startHttpFixture(): Promise<string> {
  const mcp = new McpServer({ name: 'http-fixture', version: '1.0.0' })
  mcp.registerTool('greet', {
    description: 'Greet by name',
    inputSchema: z.object({ name: z.string() }),
  }, async ({ name }) => ({
    content: [{ type: 'text', text: `hello, ${name}` }],
  }))
  // No sessionIdGenerator: session management disabled — the server runs in
  // the 2026-07-28 stateless mode, exactly what modern-era servers do.
  const transport = new WebStandardStreamableHTTPServerTransport()
  await mcp.connect(transport)

  http = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks).toString('utf8')
      const webReq = new Request(`http://127.0.0.1${req.url ?? '/'}`, {
        method: req.method ?? 'POST',
        headers: req.headers as Record<string, string>,
        ...(body !== '' ? { body } : {}),
      })
      const webRes = await transport.handleRequest(webReq)
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()))
      res.end(await webRes.text())
    })().catch((e) => {
      res.writeHead(500); res.end(String(e))
    })
  })
  await new Promise<void>((resolve) => { http?.listen(0, '127.0.0.1', resolve) })
  const address = http?.address()
  if (address === null || address === undefined || typeof address === 'string') throw new Error('no address')
  return `http://127.0.0.1:${address.port}/mcp`
}

describe('streamable-http e2e (2026-07-28 era)', () => {
  it('connects to a stateless server, lists and calls tools', async () => {
    const url = await startHttpFixture()
    const { ctx, tools } = makeCtx()
    const config: Config = {
      transport: 'streamable-http',
      serverName: 'web',
      url,
      headers: {},
      toolCallTimeoutMs: 10_000,
      failOnStartupError: true,
    }
    const handle = startConnection(ctx, config, POLICY)
    const outcome = await handle.ready
    expect(outcome.error).toBeUndefined()

    const greet = tools.registered.get('mcp__web__greet') as ToolDefinition
    expect(greet).toBeDefined()
    const result = await greet.execute(
      { name: 'stateless' },
      fakeExec() as unknown as ToolRunContext,
    ) as { content: Array<{ type: string; text?: string }> }
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello, stateless' })

    await handle.dispose()
    expect(tools.registered.size).toBe(0)
  })
})
