import { describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DispatchRegistry, defaultRegistryPath } from "../src/registry"

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "bridge-registry-"))
  return join(dir, "dispatches.json")
}

describe("DispatchRegistry", () => {
  it("computes a default path under XDG data home", () => {
    expect(defaultRegistryPath()).toContain("opencode-agent-bridge")
  })

  it("stores, reads and deletes records", () => {
    const registry = new DispatchRegistry(tempFile())
    expect(registry.has("ses_b")).toBe(false)
    expect(registry.get("ses_b")).toBeUndefined()

    const ts = Date.now()
    registry.set("ses_b", { sender: "ses_a", ts, watermark: "m0", probe: "hello" })
    expect(registry.has("ses_b")).toBe(true)
    expect(registry.get("ses_b")).toEqual({ sender: "ses_a", ts, watermark: "m0", probe: "hello" })
    expect(registry.list()).toEqual([{ target: "ses_b", sender: "ses_a", ts, watermark: "m0", probe: "hello" }])

    expect(registry.delete("ses_b")).toBe(true)
    expect(registry.has("ses_b")).toBe(false)

    expect(registry.delete("never-existed")).toBe(false)
    expect(registry.list()).toEqual([])
  })

  it("persists records to disk and reloads them", async () => {
    const file = tempFile()
    const registry = new DispatchRegistry(file)
    const ts = Date.now()
    registry.set("ses_b", { sender: "ses_a", ts, watermark: "m1" })
    await registry.flushed()

    const reloaded = new DispatchRegistry(file)
    expect(reloaded.get("ses_b")).toEqual({ sender: "ses_a", ts, watermark: "m1" })
    rmSync(file, { force: true })
  })

  it("removes deleted records from disk", async () => {
    const file = tempFile()
    const registry = new DispatchRegistry(file)
    registry.set("ses_b", { sender: "ses_a", ts: Date.now() })
    registry.set("ses_c", { sender: "ses_a", ts: Date.now() })
    await registry.flushed()
    registry.delete("ses_b")
    await registry.flushed()

    const reloaded = new DispatchRegistry(file)
    expect(reloaded.has("ses_b")).toBe(false)
    expect(reloaded.has("ses_c")).toBe(true)
  })

  it("tolerates a missing or corrupt file", () => {
    const file = tempFile()
    writeFileSync(file, "{ not valid json", "utf8")
    const registry = new DispatchRegistry(file)
    expect(registry.list()).toEqual([])
    registry.set("ses_b", { sender: "ses_a", ts: Date.now() })
    expect(registry.get("ses_b")).toBeDefined()
  })

  it("ignores malformed records when loading", () => {
    const file = tempFile()
    const now = Date.now()
    writeFileSync(
      file,
      JSON.stringify({
        good: { sender: "ses_a", ts: now },
        bad: { ts: now },
        notAnObject: "x",
      }),
      "utf8",
    )
    const registry = new DispatchRegistry(file)
    expect(registry.get("good")).toEqual({ sender: "ses_a", ts: now, watermark: undefined })
    expect(registry.has("bad")).toBe(false)
    expect(registry.has("notAnObject")).toBe(false)
  })

  it("keeps the registry file valid after multiple rapid writes", async () => {
    const file = tempFile()
    const registry = new DispatchRegistry(file)
    for (let i = 0; i < 20; i++) {
      registry.set(`ses_${i}`, { sender: "ses_a", ts: Date.now() - i * 1000 })
    }
    await registry.flushed()
    const raw = readFileSync(file, "utf8")
    expect(() => JSON.parse(raw)).not.toThrow()
    const reloaded = new DispatchRegistry(file)
    expect(reloaded.list()).toHaveLength(20)
  })

  it("deleteIf only removes the record when it is still the expected one", () => {
    const registry = new DispatchRegistry(tempFile())
    const original = { sender: "ses_a", ts: Date.now() }
    registry.set("ses_b", original)

    const replaced = { sender: "ses_c", ts: Date.now() }
    registry.set("ses_b", replaced)

    expect(registry.deleteIf("ses_b", original)).toBe(false)
    expect(registry.get("ses_b")).toBe(replaced)

    expect(registry.deleteIf("ses_b", replaced)).toBe(true)
    expect(registry.has("ses_b")).toBe(false)
  })

  it("deleteIf with undefined expected never deletes", () => {
    const registry = new DispatchRegistry(tempFile())
    registry.set("ses_b", { sender: "ses_a", ts: Date.now() })
    expect(registry.deleteIf("ses_b", undefined)).toBe(false)
    expect(registry.has("ses_b")).toBe(true)
  })

  it("setIfAbsent does not clobber an existing record", () => {
    const registry = new DispatchRegistry(tempFile())
    const first = { sender: "ses_a", ts: Date.now() }
    registry.set("ses_b", first)
    expect(registry.setIfAbsent("ses_b", { sender: "ses_c", ts: Date.now() })).toBe(false)
    expect(registry.get("ses_b")).toBe(first)

    expect(registry.setIfAbsent("ses_d", { sender: "ses_c", ts: Date.now() })).toBe(true)
    expect(registry.get("ses_d")?.sender).toBe("ses_c")
  })

  it("prunes records older than the TTL", () => {
    const registry = new DispatchRegistry(tempFile(), { ttlMs: 1000 })
    registry.set("ses_old", { sender: "ses_a", ts: Date.now() - 5000 })
    registry.set("ses_fresh", { sender: "ses_a", ts: Date.now() })

    expect(registry.get("ses_old")).toBeUndefined()
    expect(registry.get("ses_fresh")).toBeDefined()
    expect(registry.list()).toHaveLength(1)
  })

  it("prunes expired records when loading from disk", async () => {
    const file = tempFile()
    const registry = new DispatchRegistry(file)
    registry.set("ses_old", { sender: "ses_a", ts: Date.now() - 10_000 })
    await registry.flushed()

    const reloaded = new DispatchRegistry(file, { ttlMs: 1000 })
    expect(reloaded.has("ses_old")).toBe(false)
  })
})
