import { DEFAULT_NOTICE, findDispatchReply, type BridgeClient } from "./tools"
import type { DispatchRegistry } from "./registry"

export type EventHookInput = {
  event: {
    type: string
    properties?: unknown
  }
}

export type EventsDeps = {
  client: BridgeClient
  registry: DispatchRegistry
  log?: (level: "info" | "warn" | "error", message: string) => void
}

/**
 * Automatic completion notification: when a target session goes idle and a
 * dispatch record exists for it, notify the sender and clear the record.
 *
 * Concurrency guarantees:
 * - The reply check uses the stored watermark + text probe, so only the
 *   reply to *our* dispatched message counts (concurrent dispatches into the
 *   same target cannot confuse each other).
 * - The record is claimed via compare-and-swap before sending: if the record
 *   was overwritten by a newer dispatch or already claimed by another
 *   notifier, this handler backs off and touches nothing.
 * - On send failure the record is restored (only if no newer dispatch took
 *   its slot) so a later idle event or manual notify can retry.
 */
export function createEventHook(deps: EventsDeps) {
  const { client, registry, log } = deps
  return async ({ event }: EventHookInput) => {
    if (event.type !== "session.idle") return
    const properties = event.properties as { sessionID?: string } | undefined
    const target = properties?.sessionID
    if (!target) return

    const record = registry.get(target)
    if (!record) return

    let failed = false
    try {
      const messages = await client.session.messages({ path: { id: target }, query: { limit: 50 } })
      const reply = findDispatchReply(messages, record.watermark, record.probe)
      if (!reply) return
      failed = reply.info.error !== undefined && reply.info.error !== null
    } catch (err) {
      log?.("warn", `检查会话 ${target} 回复状态失败: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // CAS claim: only proceed if the record has not been overwritten by a
    // newer dispatch or already claimed by another notifier in the meantime.
    if (!registry.deleteIf(target, record)) return

    const content = failed
      ? `[System Notification] 会话 ${target} 执行你派发的任务时发生错误。可用 agent_bridge_check 查看详情。`
      : `[System Notification] ${DEFAULT_NOTICE.replaceAll("{target}", target)}`
    try {
      await client.session.promptAsync({
        path: { id: record.sender },
        body: { parts: [{ type: "text", text: content }] },
      })
      log?.("info", `已自动通知会话 ${record.sender}（任务会话 ${target} 完成）`)
    } catch (err) {
      // Restore only when no newer dispatch took the slot.
      registry.setIfAbsent(target, record)
      log?.("error", `自动通知会话 ${record.sender} 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}