import type { Plugin } from "@opencode-ai/plugin"
import { DispatchRegistry } from "./registry"
import { createEnvHook } from "./env"
import { createTools } from "./tools"
import { createEventHook } from "./events"
import { adaptClient } from "./client"

/**
 * OpenCode plugin providing cross-session agent collaboration:
 *
 * - shell.env: injects OPENCODE_SESSION_ID / OPENCODE_SESSION_CWD
 * - tools: agent_bridge_dispatch / agent_bridge_wait / agent_bridge_notify
 *          agent_bridge_check / agent_bridge_sessions
 *          agent_bridge_get_self_metadata
 * - event: session.idle auto-notification of the dispatching session
 */
export const OpenCodeAgentBridgePlugin: Plugin = async ({ client, directory }) => {
  const registry = new DispatchRegistry()
  const bridgeClient = adaptClient(client)

  const log = (level: "info" | "warn" | "error", message: string) => {
    try {
      void client.app.log({
        body: {
          service: "opencode-agent-bridge",
          level: level === "error" ? "error" : level === "warn" ? "warn" : "info",
          message,
        },
      })
    } catch {
      // Logging must never break the plugin.
    }
  }

  log("info", `plugin initialized (directory: ${directory}, registry: ${registry.file})`)

  return {
    "shell.env": createEnvHook(),
    tool: createTools({ client: bridgeClient, registry, directory }),
    event: createEventHook({ client: bridgeClient, registry, log }),
  }
}

export default OpenCodeAgentBridgePlugin
