/**
 * Stdio MCP server fixture on the v2 server SDK. Tools:
 *  - echo(text) -> text result
 *  - fail()     -> isError result
 *  - add(a, b)  -> text + structuredContent
 */
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' })

server.registerTool('echo', {
  description: 'Echo back the input text',
  inputSchema: z.object({ text: z.string() }),
}, async ({ text }) => ({
  content: [{ type: 'text', text: `echo: ${text}` }],
}))

server.registerTool('fail', {
  description: 'Always returns an MCP error result',
  inputSchema: z.object({}),
}, async () => ({
  content: [{ type: 'text', text: 'fixture failure' }],
  isError: true,
}))

server.registerTool('add', {
  description: 'Add two numbers, with structured output',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  outputSchema: z.object({ sum: z.number() }),
}, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
  structuredContent: { sum: a + b },
}))

await server.connect(new StdioServerTransport())
