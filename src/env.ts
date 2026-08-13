export type EnvHookInput = {
  cwd: string
  sessionID?: string
  callID?: string
}

export type EnvHookOutput = {
  env: Record<string, string>
}

export type EnvHook = (input: EnvHookInput, output: EnvHookOutput) => Promise<void>

/**
 * Injects bridge environment variables into every shell execution
 * (agent tools and user terminals).
 */
export function createEnvHook(): EnvHook {
  return async (input, output) => {
    if (input.sessionID) {
      output.env.OPENCODE_SESSION_ID = input.sessionID
    }
    output.env.OPENCODE_SESSION_CWD = input.cwd
  }
}