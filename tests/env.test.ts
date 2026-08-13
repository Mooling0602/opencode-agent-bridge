import { describe, expect, it } from "vitest"
import { createEnvHook } from "../src/env"

describe("shell.env hook", () => {
  it("injects session ID and cwd", async () => {
    const hook = createEnvHook()
    const output: { env: Record<string, string> } = { env: {} }
    await hook({ cwd: "/work/dir", sessionID: "ses_abc", callID: "call_1" }, output)
    expect(output.env.OPENCODE_SESSION_ID).toBe("ses_abc")
    expect(output.env.OPENCODE_SESSION_CWD).toBe("/work/dir")
  })

  it("injects only cwd when session ID is missing", async () => {
    const hook = createEnvHook()
    const output: { env: Record<string, string> } = { env: {} }
    await hook({ cwd: "/work/dir" }, output)
    expect(output.env.OPENCODE_SESSION_ID).toBeUndefined()
    expect(output.env.OPENCODE_SESSION_CWD).toBe("/work/dir")
  })
})