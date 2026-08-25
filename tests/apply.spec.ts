/** Plugin-level semantics: namespace reservation and startup-failure policy. */
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'
import type { Config } from '../src/index.js'
import { makeCtx, stdioConfig } from './helpers.js'

describe('apply', () => {
  it('rejects a duplicate serverName on the same root', async () => {
    const { ctx } = makeCtx()
    await apply(ctx, stdioConfig('dup') as Config)
    await expect(apply(ctx, stdioConfig('dup') as Config))
      .rejects.toThrow('serverName "dup" is already in use')
  })

  it('failOnStartupError=true rejects activation when the server cannot start', async () => {
    const { ctx } = makeCtx()
    await expect(apply(ctx, stdioConfig('bad', {
      command: '/nonexistent/mcp-server-binary',
      failOnStartupError: true,
    }) as Config)).rejects.toThrow('initial connection or tool synchronization failed')
  })

  it('failOnStartupError=false activates with no tools and schedules retry', async () => {
    const { ctx, tools, logs } = makeCtx()
    await apply(ctx, stdioConfig('late', {
      command: '/nonexistent/mcp-server-binary',
      failOnStartupError: false,
      reconnect: { enabled: false },
    }) as Config)
    expect(tools.registered.size).toBe(0)
    expect(logs.errors.some((m) => m.includes('reconnect is disabled'))).toBe(true)
  })
})
