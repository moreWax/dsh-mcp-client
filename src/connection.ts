/**
 * Connection supervisor: owns the MCP client/transport generations for one
 * plugin instance, keeps the harness tool registry in sync with the live
 * generation, and — when the connection drops — restarts the configured
 * server with bounded exponential backoff.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { createTransport } from './transport.js'
import { syncTools } from './tools.js'
import type { ToolBridgeOptions } from './tools.js'
import { ToolRegistrationGeneration } from './tool-registrations.js'
import type { Config, ResolvedReconnectPolicy } from './config.js'
export { RECONNECT_DEFAULTS, resolveReconnectPolicy } from './config.js'
export type { ReconnectConfig, ResolvedReconnectPolicy } from './config.js'

// The SDK's stdio transport owns two two-second termination grace periods.
// Keep one additional second for the process-close event that proves the old
// generation is gone; timing out fails closed instead of overlapping children.
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

/** Result from the initial connection attempt, for startup-await semantics. */
export interface ConnectionOutcome {
  /** If the initial connection or tool sync failed, the error; otherwise absent. */
  error?: unknown
}

/** Handle for one plugin instance's supervised connection. */
export interface ConnectionHandle {
  /** Settles when the first connection attempt completes (success or failure). */
  ready: Promise<ConnectionOutcome>
  /** Stop reconnection, quiesce work, and unregister this server's tools. */
  dispose(): Promise<void>
}

/** Mutable lifecycle state belonging to exactly one MCP Client generation. */
class GenerationState {
  readonly client = new Client({ name: 'dsh-mcp-client', version: '0.1.0' })
  readonly closed: Promise<void>
  private readonly resolveClosed: () => void
  attemptSettled = false
  closeObserved = false

  constructor(onEstablishedClose: () => void) {
    const closed = Promise.withResolvers<void>()
    this.closed = closed.promise
    this.resolveClosed = closed.resolve
    this.client.onclose = () => {
      this.closeObserved = true
      this.resolveClosed()
      // A failed connect owns its close barrier in its catch path. Once the
      // attempt has settled, the close signal owns the down transition.
      if (this.attemptSettled) onEstablishedClose()
    }
  }

  settle(): void {
    this.attemptSettled = true
  }
}

/** Serializes tool-list swaps across notifications and client generations. */
class ToolSyncQueue {
  private tail: Promise<void> = Promise.resolve()
  private registrations = ToolRegistrationGeneration.empty()

  constructor(
    private readonly ctx: Context,
    private readonly isCurrent: (generation: GenerationState) => boolean,
  ) {}

  enqueue(generation: GenerationState, opts: ToolBridgeOptions): Promise<void> {
    const run = this.tail.then(async () => {
      if (!this.isCurrent(generation)) return
      this.registrations = new ToolRegistrationGeneration(await syncTools(generation.client, this.ctx, opts, this.registrations.toMap()))
    })
    // A failed sync is reported by its enqueuing caller; later work must live.
    this.tail = run.catch(() => {})
    return run
  }

  /** Queue unregistration behind any in-flight two-phase tool swap. */
  enqueueUnregisterAll(): void {
    this.tail = this.tail.then(() => { this.unregisterAll() })
  }

  /** Quiesce all syncs and then unregister the final owned tool set. */
  async dispose(): Promise<void> {
    await this.tail
    this.unregisterAll()
  }

  private unregisterAll(): void {
    this.registrations.dispose()
    this.registrations = ToolRegistrationGeneration.empty()
  }
}

/** Owns connection generations, reconnect policy, and teardown for one server. */
class ConnectionSupervisor implements ConnectionHandle {
  readonly ready: Promise<ConnectionOutcome>

  private readonly label: string
  private readonly opts: ToolBridgeOptions
  private readonly startupOpts: ToolBridgeOptions
  private readonly syncQueue: ToolSyncQueue
  private disposed = false
  private current: GenerationState | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private failedAttempts = 0
  private connectedAt: number | undefined
  private firstAttemptError: unknown
  private settling: Promise<void>

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly policy: ResolvedReconnectPolicy,
  ) {
    this.label = `mcp-client(${config.serverName})`
    this.opts = {
      registrationFailure: 'contain',
      serverName: config.serverName,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
    }
    this.startupOpts = config.failOnStartupError
      ? { ...this.opts, registrationFailure: 'throw' }
      : this.opts
    this.syncQueue = new ToolSyncQueue(ctx, generation => this.isCurrent(generation))
    this.settling = this.connectGeneration(true)
    this.ready = this.settling.then(() => {
      // This continuation is a microtask; a post-sync stdio crash is observed
      // later, so it cannot incorrectly turn a successful startup into failure.
      if (this.current !== undefined) return {}
      /* v8 ignore next -- a failed connect/sync always records its real error */
      return { error: this.firstAttemptError ?? new Error(`${this.label}: initial connection failed`) }
    })
  }

  private isCurrent(generation: GenerationState): boolean {
    return !this.disposed && this.current === generation
  }

  private generationDown(generation: GenerationState): void {
    if (!this.isCurrent(generation)) return
    this.current = undefined
    this.scheduleReconnect()
  }

  private waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise(resolve => {
      const timeout = setTimeout(() => { resolve(false) }, GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      void closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  private scheduleReconnect(): void {
    const lostEstablishedConnection = this.connectedAt !== undefined
    if (!this.policy.enabled) {
      const message = lostEstablishedConnection
        ? 'connection lost and reconnect is disabled — registered tools will fail until an HMR reload or Host restart'
        : 'connection failed and reconnect is disabled — no tools were registered; reload the plugin or restart the Host to connect'
      this.ctx.logger.error(`${this.label}: ${message}`)
      return
    }
    if (this.connectedAt !== undefined && Date.now() - this.connectedAt >= this.policy.maxDelayMs) this.failedAttempts = 0
    this.connectedAt = undefined
    this.failedAttempts += 1
    if (this.failedAttempts > this.policy.maxAttempts) {
      this.syncQueue.enqueueUnregisterAll()
      this.ctx.logger.error(`${this.label}: giving up after ${this.policy.maxAttempts} consecutive failed reconnect attempts — tools unregistered; reload the plugin or restart the Host to reconnect`)
      return
    }
    const delayMs = Math.min(this.policy.maxDelayMs, this.policy.initialDelayMs * 2 ** (this.failedAttempts - 1))
    const action = lostEstablishedConnection ? 'connection lost; reconnecting' : 'connection failed; retrying'
    this.ctx.logger.warn(`${this.label}: ${action} in ${delayMs}ms (attempt ${this.failedAttempts}/${this.policy.maxAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.settling = this.connectGeneration(false)
    }, delayMs)
    this.reconnectTimer.unref()
  }

  private async connectGeneration(startup: boolean): Promise<void> {
    let generation!: GenerationState
    generation = new GenerationState(() => this.generationDown(generation))
    this.current = generation
    generation.client.setNotificationHandler(
      'notifications/tools/list_changed',
      async () => {
        if (!this.isCurrent(generation)) return
        this.ctx.logger.info(`${this.label}: tool list changed, re-syncing`)
        try {
          await this.syncQueue.enqueue(generation, this.opts)
        } catch (error) {
          if (!this.disposed) this.ctx.logger.error(`${this.label}: tool re-sync failed: ${String(error)}`)
        }
      },
    )

    try {
      await generation.client.connect(createTransport(this.config))
      if (generation.closeObserved) {
        generation.settle()
        this.generationDown(generation)
        return
      }
      await this.syncQueue.enqueue(generation, startup ? this.startupOpts : this.opts)
    } catch (error) {
      if (this.firstAttemptError === undefined) this.firstAttemptError = error
      if (this.isCurrent(generation)) this.ctx.logger.warn(`${this.label}: connection attempt failed: ${String(error)}`)
      try { await generation.client.close() } catch { /* transport already gone */ }
      const quiesced = generation.closeObserved || await this.waitForClose(generation.closed)
      generation.settle()
      if (!this.isCurrent(generation)) return
      if (!quiesced) {
        this.current = undefined
        this.ctx.logger.error(`${this.label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped to avoid overlapping server processes; reload the plugin or restart the Host to retry`)
        return
      }
      this.generationDown(generation)
      return
    }

    generation.settle()
    if (generation.closeObserved) {
      this.generationDown(generation)
      return
    }
    if (!this.isCurrent(generation)) return
    this.connectedAt = Date.now()
    if (this.failedAttempts > 0) this.ctx.logger.info(`${this.label}: reconnected and re-synced tools (attempt ${this.failedAttempts}/${this.policy.maxAttempts})`)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const current = this.current
    this.current = undefined
    if (current !== undefined) {
      try { await current.client.close() } catch { /* transport already gone */ }
      if (!await this.waitForClose(current.closed)) {
        this.ctx.logger.error(`${this.label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal — server shutdown may be incomplete`)
      }
    }
    // The in-flight attempt enqueues its sync before settling. Awaiting both
    // leaves the queue's disposer ownership final and safe to release.
    await this.settling
    await this.syncQueue.dispose()
  }
}

/** Start the supervised connection for one MCP server. */
export function startConnection(ctx: Context, config: Config, policy: ResolvedReconnectPolicy): ConnectionHandle {
  return new ConnectionSupervisor(ctx, config, policy)
}
