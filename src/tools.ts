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
  "The task dispatched to target session ({target}) has been completed. Use the agent_bridge_check tool to review the results."

export const DISPATCH_INSTRUCTION = `[Agent Bridge] This message was dispatched by session {sender}. When the task is done, call the agent_bridge_notify tool and pass the sender argument explicitly (value: {sender}).`

export const WAIT_INSTRUCTION = `[Agent Bridge] This message was dispatched by session {sender}. When the task is done, reply directly with the task results; no notification tool call is needed.`

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
  if (filtered.length === 0) return keyword ? `No sessions with a title containing "${keyword}".` : "(no sessions)"
  return filtered.map((s) => `- ${s.id}: ${s.title || "(untitled)"}`).join("\n")
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
      "Dispatch a message to a target opencode session asynchronously, without waiting for a reply. The current session is notified automatically (as an incoming message) once the target finishes. Do not poll or call agent_bridge_check repeatedly after dispatching; wait for the completion notification, then use agent_bridge_check to review the results.",
    args: {
      target: tool.schema.string().describe("Target session ID (query with agent_bridge_sessions)"),
      message: tool.schema.string().min(1).describe("Message content to dispatch"),
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
        return `Dispatched message to session ${target}. The current session (${sender}) will be notified automatically once the task is done — no polling needed; use agent_bridge_check after receiving the notification.`
      } catch (err) {
        return `Failed to dispatch to session ${target}: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })

  const agent_bridge_wait = tool({
    description:
      "Dispatch a message to a target opencode session and block until it replies, returning the full reply content (sync mode).",
    args: {
      target: tool.schema.string().describe("Target session ID (query with agent_bridge_sessions)"),
      message: tool.schema.string().min(1).describe("Message content to dispatch"),
      timeout: tool.schema
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum wait in seconds (default 1800)"),
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
        return `Failed to dispatch to session ${target}: ${err instanceof Error ? err.message : String(err)}`
      }

      const deadline = now() + timeoutMs
      const sentProbe = message.slice(0, 80)
      for (;;) {
        if (ctx.abort.aborted) {
          return `[Agent Bridge] Waiting for session ${target} was aborted. Use agent_bridge_check to check progress.`
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
            return `[Agent Bridge] Session ${target} failed while processing the task. Use agent_bridge_check for details.`
          }
          const body = messageText(reply)
          if (body) return `[Agent Bridge] Session ${target} replied:\n${body}`
          return `[Agent Bridge] Session ${target} finished without text content. Use agent_bridge_check to inspect.`
        }
        if (now() >= deadline) {
          return `[Agent Bridge] Timed out waiting for session ${target} to reply (${Math.round(timeoutMs / 1000)}s). Use agent_bridge_check to check progress.`
        }
        await sleep(pollIntervalMs)
      }
    },
  })

  const agent_bridge_notify = tool({
    description:
      "Manually notify the sender session that the task is complete. When sender is omitted, it is looked up from the dispatch registry for the current session.",
    args: {
      sender: tool.schema.string().optional().describe("Sender session ID to notify (auto-detected when omitted)"),
      message: tool.schema.string().optional().describe("Optional custom message"),
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
          return "No dispatch record found for the current session; pass the sender argument explicitly."
        }
        // Claim the record before sending; combined with the same claim in
        // the idle event hook this guarantees a single notification.
        if (!registry.deleteIf(executor, rec)) {
          return "The dispatch record was already handled by another notifier; skipping duplicate notification."
        }
        claimed = rec
      }
      const content = args.message
        ? `[Agent Bridge Notification] ${args.message}`
        : `[Agent Bridge Notification] ${DEFAULT_NOTICE.replaceAll("{target}", executor)}`
      try {
        await client.session.promptAsync({
          path: { id: sender },
          body: { parts: [{ type: "text", text: content }] },
        })
        return `Notified session ${sender}`
      } catch (err) {
        if (claimed) registry.setIfAbsent(executor, claimed)
        return `Failed to notify session ${sender}: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })

  const agent_bridge_check = tool({
    description:
      "Inspect a target opencode session's status and recent messages to obtain task results. Call this only after receiving the target's completion notification; do not poll this tool to wait for completion (the notification arrives automatically after dispatch).",
    args: {
      target: tool.schema.string().describe("Target session ID"),
      limit: tool.schema
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of recent messages to return (default 10)"),
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
            return text ? `[${m.info.role}] ${text}` : `[${m.info.role}] <non-text message>`
          })
          .map((l) => `- ${l}`)
          .join("\n")
        return `Session ${target} status: ${state}\nRecent messages:\n${lines || "- (none)"}`
      } catch (err) {
        return `Failed to inspect session ${target}: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })

  const agent_bridge_sessions = tool({
    description: "List available opencode sessions (filterable by title keyword), returning session IDs and titles.",
    args: {
      keyword: tool.schema.string().optional().describe("Optional title keyword filter"),
    },
    async execute(args, ctx: ToolContext) {
      try {
        const query = directory ?? ctx.directory ? { directory: directory ?? ctx.directory } : undefined
        const sessions = await client.session.list({ query })
        return formatSessionList(sessions, args.keyword)
      } catch (err) {
        return `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  })

  const agent_bridge_get_self_metadata = tool({
    description: "Return the current session's sessionID and title (read-only).",
    args: {},
    async execute(_args, ctx: ToolContext) {
      const sessionID = ctx.sessionID
      try {
        const session = await client.session.get({ path: { id: sessionID } })
        return `sessionID: ${sessionID}\ntitle: ${session.title || "(untitled)"}`
      } catch {
        return `sessionID: ${sessionID}\ntitle: (failed to fetch)`
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
