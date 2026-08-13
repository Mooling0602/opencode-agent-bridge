import { tool, type ToolContext } from "@opencode-ai/plugin"
import type { DispatchRecord, DispatchRegistry } from "./registry"

export type TextPartInput = { type: "text"; text: string }

export type BridgeMessageInfo = {
  id: string
  role: string
  parentID?: string
  time?: { created?: number; completed?: number }
  error?: unknown
}

export type BridgeMessage = {
  info: BridgeMessageInfo
  parts: Array<{ type: string; text?: string }>
}

export type BridgeSession = {
  id: string
  title: string
  time?: { updated?: number }
}

export type BridgeClient = {
  session: {
    promptAsync(input: {
      path: { id: string }
      body: { parts: TextPartInput[]; noReply?: boolean }
    }): Promise<unknown>
    messages(input: {
      path: { id: string }
      query?: { limit?: number }
    }): Promise<BridgeMessage[]>
    get(input: { path: { id: string } }): Promise<BridgeSession>
    status(input: { query: { directory?: string } }): Promise<Record<string, { type?: string }>>
    list(input: { query?: { directory?: string } }): Promise<BridgeSession[]>
  }
}

export type ToolsDeps = {
  client: BridgeClient
  registry: DispatchRegistry
  directory?: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollIntervalMs?: number
  defaultWaitTimeoutMs?: number
}

export const DEFAULT_NOTICE =
  "你派发的消息已被目标会话（{target}）处理完成。可用 agent_bridge_check 工具查看任务结果。"

export const DISPATCH_INSTRUCTION = `[Agent Bridge] 本消息由会话 {sender} 派发。任务完成后，请调用 agent_bridge_notify 工具通知发送方，并显式传入 sender 参数（值为 {sender}）。`

export const WAIT_INSTRUCTION = `[Agent Bridge] 本消息由会话 {sender} 派发。任务完成后，请直接在回复中给出任务结果，无需调用通知工具。`

export function messageText(message: BridgeMessage): string {
  return message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ")
    .trim()
}

/**
 * Find the reply to a dispatched message.
 *
 * Locates the dispatched user message (the last user message after the
 * watermark whose text matches the sent probe) and returns the assistant
 * reply that answers it (matched via parentID).
 *
 * A reply is only considered complete when `time.completed` is set (the
 * assistant message is still streaming otherwise); replies carrying an error
 * are returned immediately so callers can surface the failure.
 *
 * Returns undefined when the dispatched message or its reply cannot be
 * found yet.
 */
export function findDispatchReply(
  messages: BridgeMessage[],
  watermark: string | undefined,
  sentText?: string,
): BridgeMessage | undefined {
  const start = watermark ? messages.findIndex((m) => m.info.id === watermark) + 1 : 0
  const after = messages.slice(start)

  let dispatched: BridgeMessage | undefined
  if (sentText) {
    // Match the last user message containing the probe: resending the same
    // task into a busy session must not match an older dispatch.
    dispatched = after
      .filter((m) => m.info.role === "user" && messageText(m).includes(sentText))
      .at(-1)
  } else {
    dispatched = after.find((m) => m.info.role === "user")
  }
  if (!dispatched) return undefined

  const reply = after
    .filter((m) => m.info.role === "assistant" && m.info.parentID === dispatched.info.id)
    .at(-1)
  if (!reply) return undefined
  if (reply.info.error) return reply
  if (reply.info.time?.completed === undefined) return undefined
  return reply
}

export function formatSessionList(sessions: BridgeSession[], keyword?: string): string {
  const filtered = keyword
    ? sessions.filter((s) => (s.title || "").toLowerCase().includes(keyword.toLowerCase()))
    : sessions
  if (filtered.length === 0) return keyword ? `没有标题包含「${keyword}」的会话。` : "（无会话）"
  return filtered.map((s) => `- ${s.id}: ${s.title || "（无标题）"}`).join("\n")
}

export function createTools(deps: ToolsDeps) {
  const { client, registry } = deps
  const directory = deps.directory
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())
  const pollIntervalMs = deps.pollIntervalMs ?? 2000
  const defaultWaitTimeoutMs = deps.defaultWaitTimeoutMs ?? 1800 * 1000

  async function lastMessageId(target: string): Promise<string | undefined> {
    try {
      const messages = await client.session.messages({ path: { id: target }, query: { limit: 1 } })
      return messages.at(-1)?.info.id
    } catch {
      return undefined
    }
  }

  const agent_bridge_dispatch = tool({
    description:
      "向目标 opencode 会话异步派发消息，不等待回复。目标会话完成后会通过 agent_bridge_notify 或事件自动通知当前会话。",
    args: {
      target: tool.schema.string().describe("目标会话 ID（可用 agent_bridge_sessions 查询）"),
      message: tool.schema.string().min(1).describe("要派发的消息内容"),
    },
    async execute(args, ctx: ToolContext) {
      const { target, message } = args
      const sender = ctx.sessionID
      const watermark = await lastMessageId(target)
      const text = `${message}\n\n---\n${DISPATCH_INSTRUCTION.replaceAll("{sender}", sender)}`
      try {
        await client.session.promptAsync({
          path: { id: target },
          body: { parts: [{ type: "text", text }] },
        })
        registry.set(target, { sender, ts: Date.now(), watermark, probe: message.slice(0, 80) })
        return `已向会话 ${target} 派发消息。任务完成后会自动通知当前会话（${sender}）。`
      } catch (err) {
        return `派发到会话 ${target} 失败: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })

  const agent_bridge_wait = tool({
    description:
      "向目标 opencode 会话派发消息并阻塞等待其完成回复，完整返回回复内容（同步模式）。",
    args: {
      target: tool.schema.string().describe("目标会话 ID（可用 agent_bridge_sessions 查询）"),
      message: tool.schema.string().min(1).describe("要派发的消息内容"),
      timeout: tool.schema
        .number()
        .int()
        .min(1)
        .optional()
        .describe("最长等待秒数（默认 1800）"),
    },
    async execute(args, ctx: ToolContext) {
      const { target, message } = args
      const timeoutMs = (args.timeout ?? Math.round(defaultWaitTimeoutMs / 1000)) * 1000
      const watermark = await lastMessageId(target)
      const text = `${message}\n\n---\n${WAIT_INSTRUCTION.replaceAll("{sender}", ctx.sessionID)}`
      try {
        await client.session.promptAsync({
          path: { id: target },
          body: { parts: [{ type: "text", text }] },
        })
      } catch (err) {
        return `派发到会话 ${target} 失败: ${err instanceof Error ? err.message : String(err)}`
      }

      const deadline = now() + timeoutMs
      const sentProbe = message.slice(0, 80)
      for (;;) {
        if (ctx.abort.aborted) {
          return `[Agent Bridge] 等待会话 ${target} 回复被中断。可用 agent_bridge_check 查询进度。`
        }
        let reply: BridgeMessage | undefined
        try {
          const messages = await client.session.messages({ path: { id: target }, query: { limit: 50 } })
          reply = findDispatchReply(messages, watermark, sentProbe)
        } catch {
          // transient read failure; keep polling until timeout
        }
        if (reply) {
          if (reply.info.error) {
            return `[Agent Bridge] 会话 ${target} 的回复执行失败。可用 agent_bridge_check 查看详情。`
          }
          const body = messageText(reply)
          if (body) return `[Agent Bridge] 会话 ${target} 已回复:\n${body}`
          return `[Agent Bridge] 会话 ${target} 已完成回复（无文本内容）。可用 agent_bridge_check 查看。`
        }
        if (now() >= deadline) {
          return `[Agent Bridge] 等待会话 ${target} 回复超时（${Math.round(timeoutMs / 1000)} 秒）。可用 agent_bridge_check 查询进度。`
        }
        await sleep(pollIntervalMs)
      }
    },
  })

  const agent_bridge_notify = tool({
    description:
      "手动通知发送方会话：向调用方会话发送任务完成通知。sender 缺省时自动从派发注册表查找当前会话的发送方。",
    args: {
      sender: tool.schema.string().optional().describe("要通知的发送方会话 ID（缺省时自动查找）"),
      message: tool.schema.string().optional().describe("自定义通知附加信息（可选）"),
    },
    async execute(args, ctx: ToolContext) {
      const executor = ctx.sessionID
      let sender: string | undefined = args.sender
      let claimed: DispatchRecord | undefined
      if (sender) {
        // With an explicit sender, clear the executor's record only when it
        // points at the same sender; otherwise leave it for the automatic
        // idle notification. Restore on failure so nothing is lost.
        const rec = registry.get(executor)
        if (rec && rec.sender === sender && registry.deleteIf(executor, rec)) {
          claimed = rec
        }
      } else {
        const rec = registry.get(executor)
        sender = rec?.sender
        if (!sender) {
          return "未找到当前会话的派发记录，无法确定通知目标。请显式传入 sender 参数。"
        }
        // Claim the record before sending; combined with the same claim in
        // the idle event hook this guarantees a single notification.
        if (!registry.deleteIf(executor, rec)) {
          return "派发记录已被其他通知者处理，跳过重复通知。"
        }
        claimed = rec
      }
      const content = args.message
        ? `[System Notification] ${args.message}`
        : `[System Notification] ${DEFAULT_NOTICE.replaceAll("{target}", executor)}`
      try {
        await client.session.promptAsync({
          path: { id: sender },
          body: { parts: [{ type: "text", text: content }] },
        })
        return `已通知会话 ${sender}`
      } catch (err) {
        if (claimed) registry.setIfAbsent(executor, claimed)
        return `通知会话 ${sender} 失败: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })

  const agent_bridge_check = tool({
    description: "检查目标 opencode 会话的状态与最近消息内容，用于获取任务结果。",
    args: {
      target: tool.schema.string().describe("目标会话 ID"),
      limit: tool.schema
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("返回最近消息条数（默认 10）"),
    },
    async execute(args) {
      const { target } = args
      const limit = args.limit ?? 10
      let state = "unknown"
      try {
        const status = await client.session.status({ query: {} })
        state = status[target]?.type ?? "unknown"
      } catch {
        // status is advisory; message content is the important part
      }
      try {
        const messages = await client.session.messages({ path: { id: target }, query: { limit } })
        const lines = messages
          .map((m) => {
            const text = messageText(m)
            return text ? `[${m.info.role}] ${text}` : `[${m.info.role}] <非文本消息>`
          })
          .map((l) => `- ${l}`)
          .join("\n")
        return `会话 ${target} 状态: ${state}\n最近消息:\n${lines || "- （无）"}`
      } catch (err) {
        return `检查会话 ${target} 失败: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })

  const agent_bridge_sessions = tool({
    description: "列出可用的 opencode 会话（可按标题关键词过滤），返回会话 ID 与标题。",
    args: {
      keyword: tool.schema.string().optional().describe("按标题过滤的关键词（可选）"),
    },
    async execute(args, ctx: ToolContext) {
      try {
        const query = directory ?? ctx.directory ? { directory: directory ?? ctx.directory } : undefined
        const sessions = await client.session.list({ query })
        return formatSessionList(sessions, args.keyword)
      } catch (err) {
        return `列出会话失败: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })

  const agent_bridge_get_self_metadata = tool({
    description: "返回当前会话的 sessionID 与会话标题（只读）。",
    args: {},
    async execute(_args, ctx: ToolContext) {
      const sessionID = ctx.sessionID
      try {
        const session = await client.session.get({ path: { id: sessionID } })
        return `sessionID: ${sessionID}\ntitle: ${session.title || "（无标题）"}`
      } catch {
        return `sessionID: ${sessionID}\ntitle: （获取失败）`
      }
    },
  })

  return {
    agent_bridge_dispatch,
    agent_bridge_wait,
    agent_bridge_notify,
    agent_bridge_check,
    agent_bridge_sessions,
    agent_bridge_get_self_metadata,
  }
}
