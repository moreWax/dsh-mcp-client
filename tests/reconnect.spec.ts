import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const instances: any[] = []
  let failures = 0
  class FakeClient {
    onclose?: () => void
    async connect() { instances.push(this); if (mocks.failures-- > 0) { this.onclose?.(); throw new Error('connect failed') } }
    async close() { this.onclose?.() }
    setNotificationHandler() {}
    async request(request: any) { if (request.method === 'tools/list') return { tools: [] }; return {} }
  }
  return { instances, failures, FakeClient }
})
vi.mock('@modelcontextprotocol/client', () => ({ Client: mocks.FakeClient, StreamableHTTPClientTransport: class {} }))
vi.mock('@modelcontextprotocol/client/stdio', () => ({ StdioClientTransport: class {} }))

import { startConnection } from '../src/connection.js'
import { resolveReconnectPolicy } from '../src/config.js'
import { makeCtx, stdioConfig } from './helpers.js'

describe('ConnectionSupervisor', () => {
  beforeEach(() => { vi.useFakeTimers(); mocks.instances.length=0; mocks.failures=0 })
  it('uses bounded exponential reconnect attempts and stops', async () => {
    mocks.failures=3
    const {ctx,logs}=makeCtx()
    const handle=startConnection(ctx,stdioConfig('retry'),resolveReconnectPolicy({initialDelayMs:10,maxDelayMs:25,maxAttempts:2},'test'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(20)
    expect(mocks.instances).toHaveLength(3)
    expect(logs.errors.some(x=>x.includes('giving up after 2'))).toBe(true)
    await handle.dispose()
  })
  it('disposal cancels an armed reconnect timer', async () => {
    mocks.failures=1
    const {ctx}=makeCtx()
    const handle=startConnection(ctx,stdioConfig('dispose'),resolveReconnectPolicy({initialDelayMs:10,maxAttempts:2},'test'))
    await vi.advanceTimersByTimeAsync(0)
    await handle.dispose()
    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.instances).toHaveLength(1)
  })
})
