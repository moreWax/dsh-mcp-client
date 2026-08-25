/** Shared MCP-client configuration vocabulary and runtime resolution. */
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

export interface ReconnectConfig {
  enabled?: boolean
  initialDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
}
export const RECONNECT_DEFAULTS: Required<ReconnectConfig> = Object.freeze({ enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 })
export type ResolvedReconnectPolicy = Readonly<Required<ReconnectConfig>>

interface CommonConfig {
  serverName: string
  toolCallTimeoutMs: number
  failOnStartupError: boolean
  reconnect?: ReconnectConfig
}
export interface StdioConfig extends CommonConfig {
  transport: 'stdio'; command: string; args: string[]; env: Record<string, string>; cwd: string
}
export interface StreamableHttpConfig extends CommonConfig {
  transport: 'streamable-http'; url: string; headers: Record<string, string>
}
export type Config = StdioConfig | StreamableHttpConfig

export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

function positiveTimer(value: number, path: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) throw new Error(`${path} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  return value
}
function positiveInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${path} must be a positive integer`)
  return value
}
export function resolveReconnectPolicy(config: ReconnectConfig | undefined, path: string): ResolvedReconnectPolicy {
  if (config !== undefined) for (const key of Object.keys(config)) if (!Object.hasOwn(RECONNECT_DEFAULTS, key)) throw new Error(`${path}.${key} is not a reconnect option`)
  const initialDelayMs = positiveTimer(config?.initialDelayMs ?? RECONNECT_DEFAULTS.initialDelayMs, `${path}.initialDelayMs`)
  const maxDelayMs = positiveTimer(config?.maxDelayMs ?? RECONNECT_DEFAULTS.maxDelayMs, `${path}.maxDelayMs`)
  if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  return Object.freeze({ enabled: config?.enabled ?? RECONNECT_DEFAULTS.enabled, initialDelayMs, maxDelayMs, maxAttempts: positiveInteger(config?.maxAttempts ?? RECONNECT_DEFAULTS.maxAttempts, `${path}.maxAttempts`) })
}
export function resolveToolCallTimeout(value: number, path: string): number { return positiveTimer(value, path) }

const Reconnect: z<ReconnectConfig> = z.object({
  enabled: z.boolean().default(RECONNECT_DEFAULTS.enabled),
  initialDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.initialDelayMs),
  maxDelayMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(RECONNECT_DEFAULTS.maxDelayMs),
  maxAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(RECONNECT_DEFAULTS.maxAttempts),
})
const commonFields = {
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  reconnect: Reconnect,
}
export const ConfigSchema: z<Config> = z.union([
  z.object({ transport: z.const('stdio'), ...commonFields, command: z.string().required(), args: z.array(String).default([]), env: z.dict(String).default({}), cwd: z.string().default('') }),
  z.object({ transport: z.const('streamable-http'), ...commonFields, url: z.string().required(), headers: z.dict(String).default({}) }),
]) as unknown as z<Config>
