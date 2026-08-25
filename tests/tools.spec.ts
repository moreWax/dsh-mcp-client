import { describe, expect, it } from 'vitest'
import { syncTools } from '../src/tools.js'
import { fakeExec, makeCtx, requireTool } from './helpers.js'

const opts = { registrationFailure: 'throw' as const, serverName: 'srv', toolCallTimeoutMs: 1000 }
function client(responses: Array<unknown | Error>) {
  const requests: unknown[] = []
  return { requests, async request(request: unknown) { requests.push(request); const next=responses.shift(); if(next instanceof Error) throw next; return next } } as never
}
const tool = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } })

describe('tool registry transaction', () => {
  it('drains pagination before replacing the previous generation', async () => {
    const { ctx, tools } = makeCtx(); let oldDisposed=0
    const previous = new Map([['old',()=>{oldDisposed++}]])
    const c=client([{tools:[tool('a')],nextCursor:'c1'},{tools:[tool('b')]}])
    const next=await syncTools(c,ctx,opts,previous)
    expect(oldDisposed).toBe(1); expect([...next]).toHaveLength(2)
    expect((c as never as {requests:any[]}).requests[1]).toMatchObject({method:'tools/list',params:{cursor:'c1'}})
    expect([...tools.registered]).toHaveLength(2)
  })
  it('keeps the previous generation when a later page fails', async () => {
    const {ctx}=makeCtx(); let disposed=0
    await expect(syncTools(client([{tools:[tool('a')],nextCursor:'c'},new Error('page failed')]),ctx,opts,new Map([['old',()=>{disposed++}]]))).rejects.toThrow('page failed')
    expect(disposed).toBe(0)
  })
  it('rejects duplicate tools across pages before registry mutation', async () => {
    const {ctx}=makeCtx(); let disposed=0
    await expect(syncTools(client([{tools:[tool('a')],nextCursor:'c'},{tools:[tool('a')]}]),ctx,opts,new Map([['old',()=>{disposed++}]]))).rejects.toThrow('more than once')
    expect(disposed).toBe(0)
  })
  it('rolls back a partial registration conflict', async () => {
    const {ctx,tools}=makeCtx(); tools.register({name:'mcp__srv__taken'} as never)
    await expect(syncTools(client([{tools:[tool('free'),tool('taken'),tool('after')]}]),ctx,opts,new Map())).rejects.toThrow('duplicate')
    expect([...tools.registered.keys()]).toEqual(['mcp__srv__taken'])
  })
})

describe('call normalization', () => {
  async function definition(result: unknown, descriptor: Record<string,unknown> = tool('x')) {
    const {ctx,tools}=makeCtx(); const c=client([{tools:[descriptor]},{...result as object}])
    await syncTools(c,ctx,opts,new Map()); return requireTool(tools,'mcp__srv__x')
  }
  it('normalizes legacy toolResult and structured content', async () => {
    const def=await definition({toolResult:{x:1},structuredContent:{ok:true}})
    await expect(def.execute({},fakeExec())).resolves.toEqual({content:[{type:'text',text:'{"x":1}'}],structuredContent:{ok:true}})
  })
  it('refuses MRTR before rendering content', async () => {
    const def=await definition({resultType:'input_required',content:[{type:'text',text:'ignored'}]})
    await expect(def.execute({},fakeExec())).rejects.toThrow('MRTR')
  })
  it('refuses task-required definitions without calling the server', async () => {
    const def=await definition({}, {...tool('x'),execution:{taskSupport:'required'}})
    await expect(def.execute({},fakeExec())).rejects.toThrow('task-based')
  })
})
