# @morewax/dsh-mcp-client

MCP client bridge for DeepSeek Harness on the **2026-07-28 stateless protocol** —
a drop-in replacement for `@deepseek-ai/dsh-mcp-client`, built on the v2 MCP
TypeScript SDK (`@modelcontextprotocol/client@2`).

Same config schema, same naming contract, same reconnect and disposal semantics.
The difference is the wire protocol: this client speaks the modern stateless
core natively and negotiates the era automatically with 2025-era servers.

## Why

The official `@deepseek-ai/dsh-mcp-client` is pinned to the v1 SDK (2025-era
protocol max). The [2026-07-28 specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
rebuilt MCP around a **stateless core**: no `initialize` handshake, no
`Mcp-Session-Id`, every request self-describing with `Mcp-Method`/`Mcp-Name`
headers, MRTR for mid-call input, and cacheable `tools/list` results. Servers
are migrating; this package lets the harness speak to them natively — and to
legacy servers through automatic era fallback.

## Install

```bash
dsh plugin add @morewax/dsh-mcp-client
```

## Configure

Identical row schema to the official client — only the `name:` changes:

```yaml
- id: mcp-github
  name: '@morewax/dsh-mcp-client'
  config:
    serverName: github
    transport: stdio
    command: npx
    args: ['-y', '@modelcontextprotocol/server-github']
    env:
      GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN

- id: mcp-search
  name: '@morewax/dsh-mcp-client'
  config:
    serverName: search
    transport: streamable-http
    url: https://mcp.example.com/mcp
    headers:
      Authorization: !!js `Bearer ${process.env.SEARCH_KEY}`
```

Tools register on `ctx.tools` as `mcp__<serverName>__<tool>` (DeepSeek
function-name contract: 64 chars, `[A-Za-z0-9_-]`, hash-suffixed on lossy
normalization — identical to the official bridge).

## Protocol behavior

| Concern | Behavior |
|---|---|
| Era negotiation | Automatic at connect: 2026-07-28 with modern servers, 2025-era revisions with legacy ones |
| Stateless servers | Native — no session id sent when the server doesn't assign one |
| Stateful servers | Session followed when the server assigns one |
| MRTR (`input_required`) | Refused loudly with a clear error — the bridge has no user-interaction channel |
| Tool list changes | Re-syncs on `notifications/tools/list_changed` (era-transparent: arrives over the subscriptions stream in the modern era) |
| Tasks extension | Tools declaring `taskSupport: 'required'` fail with a clear error, same as the official bridge |
| Reconnect | Bounded exponential backoff, one attempt budget per outage, identical policy and defaults |

## Deliberate differences from the official client

1. **MRTR guard** — a 2026-era server answering `tools/call` with
   `resultType: "input_required"` gets a clear error instead of the official
   bridge's silent `(no output)`.
2. **Empty `cwd` never reaches spawn** — the official passed `''` through.
3. **Auth headers are passed at `requestInit.headers`** — the only place the
   v2 SDK reads them.

Everything else — naming, two-phase tool sync with conflict rollback,
serverName namespace reservation, reconnect budget semantics, image admission
through the durable attachment store — is behaviorally identical.

## Verify

```bash
pnpm install
pnpm run typecheck   # 0 errors
pnpm test            # 18 tests: unit + stdio e2e + stateless-http e2e + apply semantics
pnpm run build
```

The HTTP e2e runs a real v2 `McpServer` in **stateless mode** (no
`sessionIdGenerator`) and round-trips a tool call through the plugin — the
exact modern-era path.

## License

MIT
