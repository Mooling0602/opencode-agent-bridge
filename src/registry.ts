import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export type DispatchRecord = {
  /** Session ID of the dispatching (caller) session. */
  sender: string
  /** Dispatch timestamp (epoch ms). */
  ts: number
  /** ID of the last message in the target session before dispatch. */
  watermark?: string
  /** Text probe used to identify the dispatched message later. */
  probe?: string
}

export function defaultRegistryPath(): string {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "opencode-agent-bridge", "dispatches.json")
}

export type RegistryOptions = {
  /** Records older than this many milliseconds are pruned. Default 7 days. */
  ttlMs?: number
}

/**
 * Tracks dispatch relationships: target session ID -> caller session ID.
 * Backed by a JSON file so relationships survive opencode restarts.
 */
export class DispatchRegistry {
  readonly file: string
  private readonly ttlMs: number
  private records = new Map<string, DispatchRecord>()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(file: string = defaultRegistryPath(), options: RegistryOptions = {}) {
    this.file = file
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000
    this.load()
  }

  load(): void {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"))
      if (parsed && typeof parsed === "object") {
        for (const [target, value] of Object.entries(parsed as Record<string, unknown>)) {
          const rec = value as Partial<DispatchRecord> | null
          if (rec && typeof rec.sender === "string" && rec.sender.length > 0) {
            this.records.set(target, {
              sender: rec.sender,
              ts: Number(rec.ts) || 0,
              watermark: typeof rec.watermark === "string" ? rec.watermark : undefined,
              probe: typeof rec.probe === "string" ? rec.probe : undefined,
            })
          }
        }
      }
    } catch {
      // Missing or corrupt file: start with an empty registry.
    }
    this.prune()
  }

  get(target: string): DispatchRecord | undefined {
    this.prune()
    return this.records.get(target)
  }

  has(target: string): boolean {
    this.prune()
    return this.records.has(target)
  }

  set(target: string, record: DispatchRecord): void {
    this.records.set(target, record)
    this.persist()
  }

  /**
   * Removes the record for a target session.
   * Returns true when a record was actually removed. The return value can be
   * used as an atomic claim so that only one notifier wins the race.
   */
  delete(target: string): boolean {
    const existed = this.records.delete(target)
    if (existed) this.persist()
    return existed
  }

  /**
   * Compare-and-swap delete: removes the record only if it is still the same
   * object returned by a previous `get`. Prevents a stale notifier (e.g. an
   * idle event that awaited between get and delete) from removing a record
   * that was overwritten by a newer dispatch in the meantime.
   */
  deleteIf(target: string, expected: DispatchRecord | undefined): boolean {
    if (!expected) return false
    if (this.records.get(target) !== expected) return false
    return this.delete(target)
  }

  /**
   * Sets the record only when the target has no record yet. Used to restore
   * a claimed record after a failed notification without clobbering a newer
   * dispatch that arrived during the send attempt.
   */
  setIfAbsent(target: string, record: DispatchRecord): boolean {
    if (this.records.has(target)) return false
    this.set(target, record)
    return true
  }

  list(): Array<{ target: string } & DispatchRecord> {
    this.prune()
    return [...this.records.entries()].map(([target, rec]) => ({ target, ...rec }))
  }

  /** Resolves once all queued writes have been flushed to disk. */
  flushed(): Promise<void> {
    return this.writeQueue
  }

  /** Drops records older than the TTL. */
  private prune(): void {
    const now = Date.now()
    let changed = false
    for (const [target, rec] of this.records) {
      if (now - rec.ts > this.ttlMs) {
        this.records.delete(target)
        changed = true
      }
    }
    if (changed) this.persist()
  }

  private persist(): void {
    this.writeQueue = this.writeQueue.then(() => {
      try {
        const dir = dirname(this.file)
        mkdirSync(dir, { recursive: true })
        const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
        writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2))
        renameSync(tmp, this.file)
      } catch {
        // Persistence is best-effort; in-memory state stays authoritative.
      }
    })
  }

  private snapshot(): Record<string, DispatchRecord> {
    return Object.fromEntries(this.records.entries())
  }
}