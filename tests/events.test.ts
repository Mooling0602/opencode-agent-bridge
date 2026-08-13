import { describe, expect, it, vi } from "vitest"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DispatchRegistry } from "../src/registry"
import { createEventHook } from "../src/events"
import type { BridgeClient, BridgeMessage } from "../src/tools"

function msg(
  id: string,
  role: string,
  text?: string,
  parentID?: string,
  opts: { completed?: boolean; error?: boolean } = {},
): BridgeMessage {
  return {
    info: {
      id,
      role,
      parentID,
      time: { created: 1, ...(opts.completed === false ? {} : { completed: 2 }) },
      ...(opts.error ? { error: { message: "boom" } } : {}),
    },
    parts: text ? [{ type: "text", text }] : [],
  }
}

function makeClient(overrides?: Partial<BridgeClient["session"]>): BridgeClient {
  return {
    session: {
      promptAsync: vi.fn().mockResolvedValue(undefined),
      messages: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue({ id: "x", title: "x" }),
      status: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue([]),
      ...overrides,
    },
  }
}

function makeRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-events-"))
  return new DispatchRegistry(join(dir, "dispatches.json"))
}

describe("event hook", () => {
  it("ignores non-idle events", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const hook = createEventHook({ client, registry })

    await hook({ event: { type: "session.created", properties: { sessionID: "ses_b" } } })
    expect(client.session.messages).not.toHaveBeenCalled()
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("does nothing when no dispatch record exists", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const hook = createEventHook({ client, registry })

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("does not notify while the target has not replied yet", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([msg("m0", "assistant", "旧回复"), msg("u1", "user", "派发内容")]),
    })
    const registry = makeRegistry()
    registry.set("ses_b", { sender: "ses_a", ts: Date.now(), watermark: "m0", probe: "派发内容" })
    const hook = createEventHook({ client, registry })

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(registry.has("ses_b")).toBe(true)
  })

  it("notifies the sender and clears the record once the reply exists", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([
        msg("m0", "assistant", "旧回复"),
        msg("u1", "user", "派发内容"),
        msg("a1", "assistant", "任务结果", "u1"),
      ]),
    })
    const registry = makeRegistry()
    registry.set("ses_b", { sender: "ses_a", ts: Date.now(), watermark: "m0", probe: "派发内容" })
    const hook = createEventHook({ client, registry })

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })

    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync).toHaveBeenCalledTimes(1)
    const call = promptAsync.mock.calls[0][0]
    expect(call.path.id).toBe("ses_a")
    expect(call.body.parts[0].text).toContain("ses_b")
    expect(call.body.parts[0].text).toContain("agent_bridge_check")
    expect(registry.has("ses_b")).toBe(false)
  })

  it("matches only the reply to the recorded dispatch probe (concurrent dispatches)", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([
        msg("m0", "assistant", "旧回复"),
        msg("u_other", "user", "另一个会话派发的任务"),
        msg("a_other", "assistant", "另一条任务的回复", "u_other"),
        msg("u1", "user", "我们派发的任务"),
        msg("a1", "assistant", "我们任务的回复", "u1"),
      ]),
    })
    const registry = makeRegistry()
    registry.set("ses_b", { sender: "ses_a", ts: Date.now(), watermark: "m0", probe: "我们派发的任务" })
    const hook = createEventHook({ client, registry })

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })

    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync.mock.calls[0][0].path.id).toBe("ses_a")
    expect(registry.has("ses_b")).toBe(false)
  })

  it("ignores replies to messages that are not our dispatch (no false notify)", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([
        msg("m0", "assistant", "旧回复"),
        msg("u_other", "user", "另一个会话派发的任务"),
        msg("a_other", "assistant", "另一条任务的回复", "u_other"),
      ]),
    })
    const registry = makeRegistry()
    registry.set("ses_b", { sender: "ses_a", ts: Date.now(), watermark: "m0", probe: "我们派发的任务" })
    const hook = createEventHook({ client, registry })

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(registry.has("ses_b")).toBe(true)
  })

  it("backs off when another notifier already claimed the record", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([
        msg("u1", "user", "派发内容"),
        msg("a1", "assistant", "任务结果", "u1"),
      ]),
    })
    const registry = makeRegistry()
    const hook = createEventHook({ client, registry })

    // Simulate a manual notify having claimed and cleared the record
    // between this hook's reply check and its send step.
    const record = { sender: "ses_a", ts: Date.now(), watermark: undefined, probe: "派发内容" }
    const messages = client.session.messages as ReturnType<typeof vi.fn>
    messages.mockImplementation(async () => {
      registry.delete("ses_b")
      return [msg("u1", "user", "派发内容"), msg("a1", "assistant", "任务结果", "u1")]
    })
    registry.set("ses_b", record)

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(registry.has("ses_b")).toBe(false)
  })

  it("does not clobber a newer dispatch when the record was overwritten while awaiting", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([
        msg("m0", "assistant", "旧回复"),
        msg("u1", "user", "旧任务"),
        msg("a1", "assistant", "旧任务回复", "u1"),
      ]),
    })
    const registry = makeRegistry()
    const hook = createEventHook({ client, registry })

    const oldRecord = { sender: "ses_a", ts: Date.now(), watermark: "m0", probe: "旧任务" }
    const newRecord = { sender: "ses_c", ts: Date.now(), watermark: "m0", probe: "新任务" }
    registry.set("ses_b", oldRecord)

    // While the hook awaits the messages fetch, session C dispatches a new
    // task to the same target, overwriting the record.
    const messages = client.session.messages as ReturnType<typeof vi.fn>
    messages.mockImplementation(async () => {
      registry.set("ses_b", newRecord)
      return [msg("m0", "assistant", "旧回复"), msg("u1", "user", "旧任务"), msg("a1", "assistant", "旧任务回复", "u1")]
    })

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })

    // CAS claim fails: the stale handler must not notify ses_a nor delete
    // the newer record belonging to ses_c.
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    expect(registry.get("ses_b")).toBe(newRecord)
  })

  it("notifies with an error message when the task reply carries an error", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([
        msg("u1", "user", "派发内容"),
        msg("a1", "assistant", "失败", "u1", { error: true }),
      ]),
    })
    const registry = makeRegistry()
    registry.set("ses_b", { sender: "ses_a", ts: Date.now(), watermark: undefined, probe: "派发内容" })
    const hook = createEventHook({ client, registry })

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })

    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(promptAsync.mock.calls[0][0].body.parts[0].text).toContain("发生错误")
  })

  it("keeps the record when the notification fails", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([
        msg("u1", "user", "派发内容"),
        msg("a1", "assistant", "任务结果", "u1"),
      ]),
      promptAsync: vi.fn().mockRejectedValue(new Error("sender gone")),
    })
    const registry = makeRegistry()
    registry.set("ses_b", { sender: "ses_a", ts: Date.now(), watermark: undefined, probe: "派发内容" })
    const hook = createEventHook({ client, registry })

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })
    expect(registry.has("ses_b")).toBe(true)
    expect(registry.get("ses_b")).toMatchObject({ sender: "ses_a", probe: "派发内容" })
  })

  it("restores the record after send failure so a retry can succeed", async () => {
    const promptAsync = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce(undefined)
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([
        msg("u1", "user", "派发内容"),
        msg("a1", "assistant", "任务结果", "u1"),
      ]),
      promptAsync,
    })
    const registry = makeRegistry()
    registry.set("ses_b", { sender: "ses_a", ts: Date.now(), watermark: undefined, probe: "派发内容" })
    const hook = createEventHook({ client, registry })

    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })
    expect(registry.has("ses_b")).toBe(true)

    // Second idle event retries and succeeds.
    await hook({ event: { type: "session.idle", properties: { sessionID: "ses_b" } } })
    expect(promptAsync).toHaveBeenCalledTimes(2)
    expect(registry.has("ses_b")).toBe(false)
  })
})
