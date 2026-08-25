import { describe, expect, it } from 'vitest'
import { publicToolName } from '../src/tools.js'
import { resolveReconnectPolicy, RECONNECT_DEFAULTS } from '../src/connection.js'
import { resolveToolCallTimeout } from '../src/config.js'

describe('publicToolName', () => {
  it('passes clean names through verbatim', () => {
    expect(publicToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
  })

  it('normalizes invalid chars and appends an identity hash', () => {
    const name = publicToolName('srv', 'tool.with.dots')
    expect(name).toMatch(/^mcp__srv__tool_with_dots_[0-9a-f]{12}$/)
  })

  it('caps at the 64-char DeepSeek function-name budget with a hash suffix', () => {
    const name = publicToolName('srv', 'x'.repeat(80))
    expect(name.length).toBe(64)
    expect(name).toMatch(/_[0-9a-f]{12}$/)
  })

  it('never collapses distinct identities into one public name', () => {
    const a = publicToolName('srv', 'tool.a')
    const b = publicToolName('srv', 'tool_a')
    expect(a).not.toBe(b)
  })
})

describe('resolveReconnectPolicy', () => {
  it('fills defaults when omitted', () => {
    expect(resolveReconnectPolicy(undefined, 'test')).toEqual(RECONNECT_DEFAULTS)
  })

  it('rejects unknown keys', () => {
    expect(() => resolveReconnectPolicy({ enabled: true, bogus: 1 } as never, 'test'))
      .toThrow('test.bogus is not a reconnect option')
  })

  it('rejects inverted delays', () => {
    expect(() => resolveReconnectPolicy({ initialDelayMs: 1000, maxDelayMs: 100 }, 'test'))
      .toThrow('initialDelayMs must be less than or equal to maxDelayMs')
  })

  it('rejects non-positive attempts', () => {
    expect(() => resolveReconnectPolicy({ maxAttempts: 0 }, 'test'))
      .toThrow('maxAttempts must be a positive integer')
  })
})

describe('resolveToolCallTimeout',()=>{ it('rejects invalid programmatic values',()=>{ expect(()=>resolveToolCallTimeout(0,'timeout')).toThrow('positive finite') }) })
