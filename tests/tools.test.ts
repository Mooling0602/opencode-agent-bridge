import { describe, expect, it, vi } from "vitest"
import type { ToolContext } from "@opencode-ai/plugin"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DispatchRegistry } from "../src/registry"
import {
  createTools,
  findDispatchReply,
  formatSessionList,
  type BridgeClient,
  type BridgeMessage,
} from "../src/tools"

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
      get: vi.fn().mockResolvedValue({ id: "ses_target", title: "Target Session" }),
      status: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue([]),
      ...overrides,
    },
  }
}

function makeCtx(sessionID = "ses_caller"): ToolContext {
  return {
    sessionID,
    directory: "/work",
    worktree: "/work",
    messageID: "msg_ctx",
    agent: "build",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

function makeRegistry() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-tools-"))
  return new DispatchRegistry(join(dir, "dispatches.json"))
}

describe("findDispatchReply", () => {
  it("finds the assistant reply to the dispatched user message", () => {
    const messages = [
      msg("m0", "assistant", "old reply"),
      msg("u1", "user", "dispatched content"),
      msg("a1", "assistant", "task result", "u1"),
    ]
    const reply = findDispatchReply(messages, "m0", "dispatched content")
    expect(reply?.info.id).toBe("a1")
  })

  it("returns undefined when no user message follows the watermark", () => {
    expect(findDispatchReply([msg("m0", "assistant", "old reply")], "m0", "dispatched content")).toBeUndefined()
  })

  it("returns undefined when the dispatched message has no reply yet", () => {
    const messages = [msg("m0", "assistant", "old reply"), msg("u1", "user", "dispatched content")]
    expect(findDispatchReply(messages, "m0", "dispatched content")).toBeUndefined()
  })

  it("returns undefined while the reply is still streaming (no completed time)", () => {
    const messages = [
      msg("m0", "assistant", "old reply"),
      msg("u1", "user", "dispatched content"),
      msg("a1", "assistant", "partial reply...", "u1", { completed: false }),
    ]
    expect(findDispatchReply(messages, "m0", "dispatched content")).toBeUndefined()
  })

  it("returns streaming-free replies once completed", () => {
    const messages = [
      msg("m0", "assistant", "old reply"),
      msg("u1", "user", "dispatched content"),
      msg("a1", "assistant", "full reply", "u1"),
    ]
    expect(findDispatchReply(messages, "m0", "dispatched content")?.info.id).toBe("a1")
  })

  it("returns error replies immediately", () => {
    const messages = [
      msg("m0", "assistant", "old reply"),
      msg("u1", "user", "dispatched content"),
      msg("a1", "assistant", "failure", "u1", { error: true }),
    ]
    const reply = findDispatchReply(messages, "m0", "dispatched content")
    expect(reply?.info.id).toBe("a1")
    expect(reply?.info.error).toBeDefined()
  })

  it("ignores replies belonging to other user messages", () => {
    const messages = [
      msg("m0", "assistant", "old reply"),
      msg("u_old", "user", "previous question"),
      msg("a_old", "assistant", "reply to previous question", "u_old"),
      msg("u1", "user", "dispatched content"),
    ]
    expect(findDispatchReply(messages, "m0", "dispatched content")).toBeUndefined()
  })

  it("works without a watermark (dispatch into an empty session)", () => {
    const messages = [msg("u1", "user", "dispatched content"), msg("a1", "assistant", "task result", "u1")]
    expect(findDispatchReply(messages, undefined, "dispatched content")?.info.id).toBe("a1")
  })

  it("matches by text when no sent text is provided", () => {
    const messages = [msg("u1", "user", "first message"), msg("a1", "assistant", "reply", "u1")]
    expect(findDispatchReply(messages, undefined, undefined)?.info.id).toBe("a1")
  })

  it("matches the latest dispatch when the same task is resent", () => {
    const messages = [
      msg("m0", "assistant", "old reply"),
      msg("u1", "user", "first dispatch of the same task"),
      msg("a1", "assistant", "reply to the first", "u1"),
      msg("u2", "user", "second dispatch of the same task"),
      msg("a2", "assistant", "reply to the second", "u2"),
    ]
    const reply = findDispatchReply(messages, "m0", "same task")
    expect(reply?.info.id).toBe("a2")
  })

  it("falls back to the whole window when the watermark is gone", () => {
    const messages = [
      msg("u_old", "user", "other task"),
      msg("a_old", "assistant", "other reply", "u_old"),
      msg("u1", "user", "dispatched content"),
      msg("a1", "assistant", "task result", "u1"),
    ]
    expect(findDispatchReply(messages, "m_gone", "dispatched content")?.info.id).toBe("a1")
  })
})

describe("formatSessionList", () => {
  const sessions = [
    { id: "ses_1", title: "Frontend Build" },
    { id: "ses_2", title: "Backend Debug" },
  ]

  it("formats all sessions", () => {
    const out = formatSessionList(sessions)
    expect(out).toContain("ses_1: Frontend Build")
    expect(out).toContain("ses_2: Backend Debug")
  })

  it("filters by keyword", () => {
    const out = formatSessionList(sessions, "Frontend")
    expect(out).toContain("ses_1")
    expect(out).not.toContain("ses_2")
  })

  it("handles empty lists", () => {
    expect(formatSessionList([], undefined)).toBe("(no sessions)")
    expect(formatSessionList([], "keyword")).toContain("No sessions with a title containing")
  })
})

describe("agent_bridge_dispatch", () => {
  it("sends the message, records the dispatch and reports success", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([msg("m0", "assistant", "old reply")]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_dispatch.execute(
      { target: "ses_target", message: "please help me write tests" },
      makeCtx(),
    )

    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync).toHaveBeenCalledTimes(1)
    const call = promptAsync.mock.calls[0][0]
    expect(call.path.id).toBe("ses_target")
    expect(call.body.parts[0].text).toContain("please help me write tests")
    expect(call.body.parts[0].text).toContain("ses_caller")
    expect(call.body.parts[0].text).toContain("agent_bridge_notify")
    // Every {sender} placeholder must be replaced, none left literal.
    expect(call.body.parts[0].text).not.toContain("{sender}")

    expect(registry.get("ses_target")).toMatchObject({
      sender: "ses_caller",
      watermark: "m0",
      probe: "please help me write tests",
    })
    expect(result).toContain("Dispatched message to session ses_target")
  })

  it("reports failure when promptAsync throws", async () => {
    const client = makeClient({
      promptAsync: vi.fn().mockRejectedValue(new Error("network down")),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_dispatch.execute(
      { target: "ses_target", message: "hi" },
      makeCtx(),
    )
    expect(result).toContain("Failed to dispatch to session ses_target")
    expect(registry.has("ses_target")).toBe(false)
  })
})

describe("agent_bridge_wait", () => {
  it("blocks until the target replies and returns the full reply", async () => {
    const messages = vi
      .fn<() => Promise<BridgeMessage[]>>()
      .mockResolvedValueOnce([msg("m0", "assistant", "old reply")])
      .mockResolvedValueOnce([msg("m0", "assistant", "old reply"), msg("u1", "user", "please process the task")])
      .mockResolvedValue([
        msg("m0", "assistant", "old reply"),
        msg("u1", "user", "please process the task"),
        msg("a1", "assistant", "Task done, artifacts in dist/", "u1"),
      ])
    const client = makeClient({ messages })
    const registry = makeRegistry()
    const tools = createTools({
      client,
      registry,
      sleep: async () => {},
      pollIntervalMs: 1,
    })

    const result = await tools.agent_bridge_wait.execute(
      { target: "ses_target", message: "please process the task" },
      makeCtx(),
    )

    expect(result).toContain("Session ses_target replied")
    expect(result).toContain("Task done, artifacts in dist/")
    // sync wait must not register a dispatch relationship
    expect(registry.has("ses_target")).toBe(false)
  })

  it("keeps polling while the reply is streaming", async () => {
    const messages = vi
      .fn<() => Promise<BridgeMessage[]>>()
      .mockResolvedValueOnce([msg("m0", "assistant", "old reply")])
      .mockResolvedValueOnce([
        msg("m0", "assistant", "old reply"),
        msg("u1", "user", "please process the task"),
        msg("a1", "assistant", "partial reply...", "u1", { completed: false }),
      ])
      .mockResolvedValue([
        msg("m0", "assistant", "old reply"),
        msg("u1", "user", "please process the task"),
        msg("a1", "assistant", "Task done, artifacts in dist/", "u1"),
      ])
    const client = makeClient({ messages })
    const registry = makeRegistry()
    const tools = createTools({
      client,
      registry,
      sleep: async () => {},
      pollIntervalMs: 1,
    })

    const result = await tools.agent_bridge_wait.execute(
      { target: "ses_target", message: "please process the task" },
      makeCtx(),
    )
    expect(result).toContain("Task done, artifacts in dist/")
    expect(result).not.toContain("partial reply")
  })

  it("reports a textless completed reply instead of polling forever", async () => {
    const messages = vi
      .fn<() => Promise<BridgeMessage[]>>()
      .mockResolvedValueOnce([msg("m0", "assistant", "old reply")])
      .mockResolvedValue([
        msg("m0", "assistant", "old reply"),
        msg("u1", "user", "please process the task"),
        { info: { id: "a1", role: "assistant", parentID: "u1", time: { created: 1, completed: 2 } }, parts: [] },
      ])
    const client = makeClient({ messages })
    const registry = makeRegistry()
    const tools = createTools({ client, registry, sleep: async () => {}, pollIntervalMs: 1 })

    const result = await tools.agent_bridge_wait.execute(
      { target: "ses_target", message: "please process the task" },
      makeCtx(),
    )
    expect(result).toContain("without text content")
  })

  it("aborts when the tool context is aborted", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([msg("u1", "user", "please process the task")]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry, sleep: async () => {}, pollIntervalMs: 1 })
    const ctx = makeCtx()
    const controller = new AbortController()
    ctx.abort = controller.signal
    controller.abort()

    const result = await tools.agent_bridge_wait.execute(
      { target: "ses_target", message: "please process the task" },
      ctx,
    )
    expect(result).toContain("was aborted")
    expect(result).toContain("agent_bridge_check")
  })

  it("returns a timeout message when the target never replies", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([msg("m0", "assistant", "old reply"), msg("u1", "user", "please process the task")]),
    })
    const registry = makeRegistry()
    let elapsed = 0
    const tools = createTools({
      client,
      registry,
      sleep: vi.fn(async () => {
        elapsed += 60_000
      }),
      now: () => elapsed,
      defaultWaitTimeoutMs: 30_000,
      pollIntervalMs: 1,
    })

    const result = await tools.agent_bridge_wait.execute(
      { target: "ses_target", message: "please process the task" },
      makeCtx(),
    )
    expect(result).toContain("Timed out")
    expect(result).toContain("agent_bridge_check")
  })

  it("reports dispatch failure without polling", async () => {
    const client = makeClient({
      promptAsync: vi.fn().mockRejectedValue(new Error("rejected")),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry, sleep: async () => {}, pollIntervalMs: 1 })

    const result = await tools.agent_bridge_wait.execute(
      { target: "ses_target", message: "hi" },
      makeCtx(),
    )
    expect(result).toContain("Failed to dispatch to session ses_target")
    // Only the watermark lookup may run; no polling should happen.
    expect(client.session.messages).toHaveBeenCalledTimes(1)
  })
})

describe("agent_bridge_notify", () => {
  it("notifies the registered sender with the fixed notice and clears the record", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    registry.set("ses_executor", { sender: "ses_caller", ts: Date.now(), watermark: "m0" })
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_notify.execute({}, makeCtx("ses_executor"))

    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync).toHaveBeenCalledTimes(1)
    const call = promptAsync.mock.calls[0][0]
    expect(call.path.id).toBe("ses_caller")
    expect(call.body.parts[0].text).toContain("ses_executor")
    expect(call.body.parts[0].text).toContain("agent_bridge_check")
    expect(registry.has("ses_executor")).toBe(false)
    expect(result).toContain("Notified session ses_caller")
  })

  it("uses the explicit sender argument", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_notify.execute({ sender: "ses_other" }, makeCtx("ses_executor"))

    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync.mock.calls[0][0].path.id).toBe("ses_other")
    expect(result).toContain("ses_other")
  })

  it("clears the executor record when the explicit sender matches it", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    registry.set("ses_executor", { sender: "ses_caller", ts: Date.now() })
    const tools = createTools({ client, registry })

    await tools.agent_bridge_notify.execute({ sender: "ses_caller" }, makeCtx("ses_executor"))
    expect(registry.has("ses_executor")).toBe(false)
  })

  it("keeps the executor record when the explicit sender differs", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const rec = { sender: "ses_caller", ts: Date.now() }
    registry.set("ses_executor", rec)
    const tools = createTools({ client, registry })

    await tools.agent_bridge_notify.execute({ sender: "ses_other" }, makeCtx("ses_executor"))
    // A different sender must not steal the automatic notification slot.
    expect(registry.get("ses_executor")).toBe(rec)
  })

  it("restores the matched record when an explicit-sender send fails", async () => {
    const client = makeClient({
      promptAsync: vi.fn().mockRejectedValue(new Error("sender gone")),
    })
    const registry = makeRegistry()
    registry.set("ses_executor", { sender: "ses_caller", ts: Date.now(), probe: "task content" })
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_notify.execute({ sender: "ses_caller" }, makeCtx("ses_executor"))
    expect(result).toContain("Failed to notify session ses_caller")
    expect(registry.get("ses_executor")).toMatchObject({ sender: "ses_caller", probe: "task content" })
  })

  it("supports a custom message", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    await tools.agent_bridge_notify.execute(
      { sender: "ses_other", message: "custom content" },
      makeCtx("ses_executor"),
    )
    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync.mock.calls[0][0].body.parts[0].text).toBe("[Agent Bridge Notification] custom content")
  })

  it("reports an error when no record and no sender argument exist", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_notify.execute({}, makeCtx("ses_executor"))
    expect(result).toContain("No dispatch record found")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("backs off when the record was already claimed by another notifier", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    registry.set("ses_executor", { sender: "ses_caller", ts: 1 })
    registry.delete("ses_executor") // simulate the idle event having won the race

    const result = await tools.agent_bridge_notify.execute({}, makeCtx("ses_executor"))
    expect(result).toContain("No dispatch record found")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("restores the record when the notification send fails", async () => {
    const client = makeClient({
      promptAsync: vi.fn().mockRejectedValue(new Error("sender gone")),
    })
    const registry = makeRegistry()
    registry.set("ses_executor", { sender: "ses_caller", ts: Date.now(), watermark: "m0", probe: "task content" })
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_notify.execute({}, makeCtx("ses_executor"))
    expect(result).toContain("Failed to notify session ses_caller")
    expect(registry.get("ses_executor")).toMatchObject({ sender: "ses_caller", probe: "task content" })
  })
})

describe("agent_bridge_check", () => {
  it("reports session status and recent messages", async () => {
    const client = makeClient({
      status: vi.fn().mockResolvedValue({ ses_target: { type: "idle" } }),
      messages: vi.fn().mockResolvedValue([
        msg("u1", "user", "question"),
        msg("a1", "assistant", "answer content"),
      ]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_check.execute({ target: "ses_target" }, makeCtx())
    expect(result).toContain("Session ses_target status: idle")
    expect(result).toContain("[user] question")
    expect(result).toContain("[assistant] answer content")
  })

  it("marks non-text messages", async () => {
    const client = makeClient({
      status: vi.fn().mockResolvedValue({}),
      messages: vi.fn().mockResolvedValue([{ info: { id: "a1", role: "assistant" }, parts: [] }]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_check.execute({ target: "ses_target" }, makeCtx())
    expect(result).toContain("<non-text message>")
  })

  it("reports errors from the client", async () => {
    const client = makeClient({
      messages: vi.fn().mockRejectedValue(new Error("not found")),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_check.execute({ target: "ses_target" }, makeCtx())
    expect(result).toContain("Failed to inspect session ses_target")
  })
})

describe("agent_bridge_sessions", () => {
  it("lists sessions with ids and titles", async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue([
        { id: "ses_1", title: "Frontend Build" },
        { id: "ses_2", title: "Backend Debug" },
      ]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_sessions.execute({}, makeCtx())
    expect(result).toContain("ses_1: Frontend Build")
    expect(result).toContain("ses_2: Backend Debug")
    const listCall = (client.session.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(listCall.query.directory).toBe("/work")
  })

  it("passes the keyword filter through", async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue([{ id: "ses_1", title: "Frontend Build" }]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_sessions.execute({ keyword: "Frontend" }, makeCtx())
    expect(result).toContain("ses_1")
    expect(result).not.toContain("ses_2")
  })
})

describe("agent_bridge_get_self_metadata", () => {
  it("returns the calling session ID and title", async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue({ id: "ses_caller", title: "My Session" }),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_get_self_metadata.execute({}, makeCtx())
    expect(result).toContain("sessionID: ses_caller")
    expect(result).toContain("title: My Session")
  })

  it("degrades gracefully when the session cannot be fetched", async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(new Error("boom")),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_get_self_metadata.execute({}, makeCtx())
    expect(result).toContain("sessionID: ses_caller")
    expect(result).toContain("(failed to fetch)")
  })
})
