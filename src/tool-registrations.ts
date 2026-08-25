/** Idempotent ownership of one complete ToolRuntime registration generation. */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

export type ToolDisposers = Map<string, () => void>
export class ToolRegistrationGeneration {
  private disposed = false
  constructor(private readonly disposers: ToolDisposers = new Map()) {}
  static empty(): ToolRegistrationGeneration { return new ToolRegistrationGeneration() }
  static register(ctx: Context, definitions: ReadonlyMap<string, ToolDefinition>): ToolRegistrationGeneration {
    const disposers: ToolDisposers = new Map()
    try {
      for (const [name, definition] of definitions) disposers.set(name, ctx.tools.register(definition))
      return new ToolRegistrationGeneration(disposers)
    } catch (error) {
      for (const dispose of disposers.values()) dispose()
      throw error
    }
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposers.values()) dispose()
    this.disposers.clear()
  }
  toMap(): ToolDisposers { return new Map(this.disposers) }
}
