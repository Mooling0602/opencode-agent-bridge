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
      get: vi.fn().mockResolvedValue({ id: "ses_target", title: "目标会话" }),
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
      msg("m0", "assistant", "旧回复"),
      msg("u1", "user", "派发内容"),
      msg("a1", "assistant", "任务结果", "u1"),
    ]
    const reply = findDispatchReply(messages, "m0", "派发内容")
    expect(reply?.info.id).toBe("a1")
  })

  it("returns undefined when no user message follows the watermark", () => {
    expect(findDispatchReply([msg("m0", "assistant", "旧回复")], "m0", "派发内容")).toBeUndefined()
  })

  it("returns undefined when the dispatched message has no reply yet", () => {
    const messages = [msg("m0", "assistant", "旧回复"), msg("u1", "user", "派发内容")]
    expect(findDispatchReply(messages, "m0", "派发内容")).toBeUndefined()
  })

  it("returns undefined while the reply is still streaming (no completed time)", () => {
    const messages = [
      msg("m0", "assistant", "旧回复"),
      msg("u1", "user", "派发内容"),
      msg("a1", "assistant", "部分回复...", "u1", { completed: false }),
    ]
    expect(findDispatchReply(messages, "m0", "派发内容")).toBeUndefined()
  })

  it("returns streaming-free replies once completed", () => {
    const messages = [
      msg("m0", "assistant", "旧回复"),
      msg("u1", "user", "派发内容"),
      msg("a1", "assistant", "完整回复", "u1"),
    ]
    expect(findDispatchReply(messages, "m0", "派发内容")?.info.id).toBe("a1")
  })

  it("returns error replies immediately", () => {
    const messages = [
      msg("m0", "assistant", "旧回复"),
      msg("u1", "user", "派发内容"),
      msg("a1", "assistant", "失败", "u1", { error: true }),
    ]
    const reply = findDispatchReply(messages, "m0", "派发内容")
    expect(reply?.info.id).toBe("a1")
    expect(reply?.info.error).toBeDefined()
  })

  it("ignores replies belonging to other user messages", () => {
    const messages = [
      msg("m0", "assistant", "旧回复"),
      msg("u_old", "user", "之前的问题"),
      msg("a_old", "assistant", "之前问题的回复", "u_old"),
      msg("u1", "user", "派发内容"),
    ]
    expect(findDispatchReply(messages, "m0", "派发内容")).toBeUndefined()
  })

  it("works without a watermark (dispatch into an empty session)", () => {
    const messages = [msg("u1", "user", "派发内容"), msg("a1", "assistant", "任务结果", "u1")]
    expect(findDispatchReply(messages, undefined, "派发内容")?.info.id).toBe("a1")
  })

  it("matches by text when no sent text is provided", () => {
    const messages = [msg("u1", "user", "第一条消息"), msg("a1", "assistant", "回复", "u1")]
    expect(findDispatchReply(messages, undefined, undefined)?.info.id).toBe("a1")
  })

  it("matches the latest dispatch when the same task is resent", () => {
    const messages = [
      msg("m0", "assistant", "旧回复"),
      msg("u1", "user", "同样任务的第一次派发"),
      msg("a1", "assistant", "第一次的回复", "u1"),
      msg("u2", "user", "同样任务的第二次派发"),
      msg("a2", "assistant", "第二次的回复", "u2"),
    ]
    const reply = findDispatchReply(messages, "m0", "同样任务的")
    expect(reply?.info.id).toBe("a2")
  })

  it("falls back to the whole window when the watermark is gone", () => {
    const messages = [
      msg("u_old", "user", "其他任务"),
      msg("a_old", "assistant", "其他回复", "u_old"),
      msg("u1", "user", "派发内容"),
      msg("a1", "assistant", "任务结果", "u1"),
    ]
    expect(findDispatchReply(messages, "m_gone", "派发内容")?.info.id).toBe("a1")
  })
})

describe("formatSessionList", () => {
  const sessions = [
    { id: "ses_1", title: "前端构建" },
    { id: "ses_2", title: "后端调试" },
  ]

  it("formats all sessions", () => {
    const out = formatSessionList(sessions)
    expect(out).toContain("ses_1: 前端构建")
    expect(out).toContain("ses_2: 后端调试")
  })

  it("filters by keyword", () => {
    const out = formatSessionList(sessions, "前端")
    expect(out).toContain("ses_1")
    expect(out).not.toContain("ses_2")
  })

  it("handles empty lists", () => {
    expect(formatSessionList([], undefined)).toBe("（无会话）")
    expect(formatSessionList([], "关键词")).toContain("没有标题包含")
  })
})

describe("agent_bridge_dispatch", () => {
  it("sends the message, records the dispatch and reports success", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([msg("m0", "assistant", "旧回复")]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_dispatch.execute(
      { target: "ses_target", message: "请帮我写测试" },
      makeCtx(),
    )

    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync).toHaveBeenCalledTimes(1)
    const call = promptAsync.mock.calls[0][0]
    expect(call.path.id).toBe("ses_target")
    expect(call.body.parts[0].text).toContain("请帮我写测试")
    expect(call.body.parts[0].text).toContain("ses_caller")
    expect(call.body.parts[0].text).toContain("agent_bridge_notify")
    // Every {sender} placeholder must be replaced, none left literal.
    expect(call.body.parts[0].text).not.toContain("{sender}")

    expect(registry.get("ses_target")).toMatchObject({
      sender: "ses_caller",
      watermark: "m0",
      probe: "请帮我写测试",
    })
    expect(result).toContain("已向会话 ses_target 派发消息")
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
    expect(result).toContain("派发到会话 ses_target 失败")
    expect(registry.has("ses_target")).toBe(false)
  })
})

describe("agent_bridge_wait", () => {
  it("blocks until the target replies and returns the full reply", async () => {
    const messages = vi
      .fn<() => Promise<BridgeMessage[]>>()
      .mockResolvedValueOnce([msg("m0", "assistant", "旧回复")])
      .mockResolvedValueOnce([msg("m0", "assistant", "旧回复"), msg("u1", "user", "请处理任务")])
      .mockResolvedValue([
        msg("m0", "assistant", "旧回复"),
        msg("u1", "user", "请处理任务"),
        msg("a1", "assistant", "任务已完成，产物在 dist/", "u1"),
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
      { target: "ses_target", message: "请处理任务" },
      makeCtx(),
    )

    expect(result).toContain("ses_target 已回复")
    expect(result).toContain("任务已完成，产物在 dist/")
    // sync wait must not register a dispatch relationship
    expect(registry.has("ses_target")).toBe(false)
  })

  it("keeps polling while the reply is streaming", async () => {
    const messages = vi
      .fn<() => Promise<BridgeMessage[]>>()
      .mockResolvedValueOnce([msg("m0", "assistant", "旧回复")])
      .mockResolvedValueOnce([
        msg("m0", "assistant", "旧回复"),
        msg("u1", "user", "请处理任务"),
        msg("a1", "assistant", "部分回复...", "u1", { completed: false }),
      ])
      .mockResolvedValue([
        msg("m0", "assistant", "旧回复"),
        msg("u1", "user", "请处理任务"),
        msg("a1", "assistant", "任务已完成，产物在 dist/", "u1"),
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
      { target: "ses_target", message: "请处理任务" },
      makeCtx(),
    )
    expect(result).toContain("任务已完成，产物在 dist/")
    expect(result).not.toContain("部分回复")
  })

  it("reports a textless completed reply instead of polling forever", async () => {
    const messages = vi
      .fn<() => Promise<BridgeMessage[]>>()
      .mockResolvedValueOnce([msg("m0", "assistant", "旧回复")])
      .mockResolvedValue([
        msg("m0", "assistant", "旧回复"),
        msg("u1", "user", "请处理任务"),
        { info: { id: "a1", role: "assistant", parentID: "u1", time: { created: 1, completed: 2 } }, parts: [] },
      ])
    const client = makeClient({ messages })
    const registry = makeRegistry()
    const tools = createTools({ client, registry, sleep: async () => {}, pollIntervalMs: 1 })

    const result = await tools.agent_bridge_wait.execute(
      { target: "ses_target", message: "请处理任务" },
      makeCtx(),
    )
    expect(result).toContain("无文本内容")
  })

  it("aborts when the tool context is aborted", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([msg("u1", "user", "请处理任务")]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry, sleep: async () => {}, pollIntervalMs: 1 })
    const ctx = makeCtx()
    const controller = new AbortController()
    ctx.abort = controller.signal
    controller.abort()

    const result = await tools.agent_bridge_wait.execute(
      { target: "ses_target", message: "请处理任务" },
      ctx,
    )
    expect(result).toContain("被中断")
    expect(result).toContain("agent_bridge_check")
  })

  it("returns a timeout message when the target never replies", async () => {
    const client = makeClient({
      messages: vi.fn().mockResolvedValue([msg("m0", "assistant", "旧回复"), msg("u1", "user", "请处理任务")]),
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
      { target: "ses_target", message: "请处理任务" },
      makeCtx(),
    )
    expect(result).toContain("超时")
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
    expect(result).toContain("派发到会话 ses_target 失败")
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
    expect(result).toContain("已通知会话 ses_caller")
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
    registry.set("ses_executor", { sender: "ses_caller", ts: Date.now(), probe: "任务内容" })
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_notify.execute({ sender: "ses_caller" }, makeCtx("ses_executor"))
    expect(result).toContain("通知会话 ses_caller 失败")
    expect(registry.get("ses_executor")).toMatchObject({ sender: "ses_caller", probe: "任务内容" })
  })

  it("supports a custom message", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    await tools.agent_bridge_notify.execute(
      { sender: "ses_other", message: "自定义内容" },
      makeCtx("ses_executor"),
    )
    const promptAsync = client.session.promptAsync as ReturnType<typeof vi.fn>
    expect(promptAsync.mock.calls[0][0].body.parts[0].text).toBe("[System Notification] 自定义内容")
  })

  it("reports an error when no record and no sender argument exist", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_notify.execute({}, makeCtx("ses_executor"))
    expect(result).toContain("未找到当前会话的派发记录")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("backs off when the record was already claimed by another notifier", async () => {
    const client = makeClient()
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    registry.set("ses_executor", { sender: "ses_caller", ts: 1 })
    registry.delete("ses_executor") // simulate the idle event having won the race

    const result = await tools.agent_bridge_notify.execute({}, makeCtx("ses_executor"))
    expect(result).toContain("未找到当前会话的派发记录")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("restores the record when the notification send fails", async () => {
    const client = makeClient({
      promptAsync: vi.fn().mockRejectedValue(new Error("sender gone")),
    })
    const registry = makeRegistry()
    registry.set("ses_executor", { sender: "ses_caller", ts: Date.now(), watermark: "m0", probe: "任务内容" })
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_notify.execute({}, makeCtx("ses_executor"))
    expect(result).toContain("通知会话 ses_caller 失败")
    expect(registry.get("ses_executor")).toMatchObject({ sender: "ses_caller", probe: "任务内容" })
  })
})

describe("agent_bridge_check", () => {
  it("reports session status and recent messages", async () => {
    const client = makeClient({
      status: vi.fn().mockResolvedValue({ ses_target: { type: "idle" } }),
      messages: vi.fn().mockResolvedValue([
        msg("u1", "user", "问题"),
        msg("a1", "assistant", "回答内容"),
      ]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_check.execute({ target: "ses_target" }, makeCtx())
    expect(result).toContain("会话 ses_target 状态: idle")
    expect(result).toContain("[user] 问题")
    expect(result).toContain("[assistant] 回答内容")
  })

  it("marks non-text messages", async () => {
    const client = makeClient({
      status: vi.fn().mockResolvedValue({}),
      messages: vi.fn().mockResolvedValue([{ info: { id: "a1", role: "assistant" }, parts: [] }]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_check.execute({ target: "ses_target" }, makeCtx())
    expect(result).toContain("<非文本消息>")
  })

  it("reports errors from the client", async () => {
    const client = makeClient({
      messages: vi.fn().mockRejectedValue(new Error("not found")),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_check.execute({ target: "ses_target" }, makeCtx())
    expect(result).toContain("检查会话 ses_target 失败")
  })
})

describe("agent_bridge_sessions", () => {
  it("lists sessions with ids and titles", async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue([
        { id: "ses_1", title: "前端构建" },
        { id: "ses_2", title: "后端调试" },
      ]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_sessions.execute({}, makeCtx())
    expect(result).toContain("ses_1: 前端构建")
    expect(result).toContain("ses_2: 后端调试")
    const listCall = (client.session.list as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(listCall.query.directory).toBe("/work")
  })

  it("passes the keyword filter through", async () => {
    const client = makeClient({
      list: vi.fn().mockResolvedValue([{ id: "ses_1", title: "前端构建" }]),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_sessions.execute({ keyword: "前端" }, makeCtx())
    expect(result).toContain("ses_1")
    expect(result).not.toContain("ses_2")
  })
})

describe("agent_bridge_get_self_metadata", () => {
  it("returns the calling session ID and title", async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue({ id: "ses_caller", title: "我的会话" }),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_get_self_metadata.execute({}, makeCtx())
    expect(result).toContain("sessionID: ses_caller")
    expect(result).toContain("title: 我的会话")
  })

  it("degrades gracefully when the session cannot be fetched", async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(new Error("boom")),
    })
    const registry = makeRegistry()
    const tools = createTools({ client, registry })

    const result = await tools.agent_bridge_get_self_metadata.execute({}, makeCtx())
    expect(result).toContain("sessionID: ses_caller")
    expect(result).toContain("（获取失败）")
  })
})
