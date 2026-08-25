import { describe, expect, it } from 'vitest'
import { extractText } from '../src/content-projection.js'

describe('MCP content projection', () => {
  it('projects mixed untrusted blocks without discarding diagnostics', () => {
    expect(extractText([
      {type:'text',text:'hello'},
      {type:'resource_link',name:'docs',uri:'file:///docs'},
      {type:'audio',mimeType:'audio/wav'},
      {type:'resource'},
      {type:'unknown'},
      3,
    ] as never,'tool')).toContain('hello\nResource link: docs (file:///docs)')
  })
  it('uses a stable no-visible-content fallback', () => {
    expect(extractText([{type:'text'}] as never,'empty')).toBe('(empty returned no model-visible content)')
  })
  it('never exposes raw image bytes in model-visible text', () => {
    const text=extractText([{type:'image',mimeType:'image/png',data:'AAAA'}] as never,'image')
    expect(text).toContain('image unavailable'); expect(text).not.toContain('AAAA')
  })
})
