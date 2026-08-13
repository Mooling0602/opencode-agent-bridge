import type { BridgeClient } from "./tools"

type ResultLike = {
  data?: unknown
  error?: unknown
  request?: unknown
  response?: unknown
}

function errorMessage(error: unknown): string {
  if (!error) return "unknown error"
  if (typeof error === "string") return error
  if (typeof error === "object") {
    const rec = error as Record<string, unknown>
    if (typeof rec.message === "string") return rec.message
    // SDK NamedError wire shape: { name, data: { message } }
    if (rec.data && typeof rec.data === "object") {
      const data = rec.data as Record<string, unknown>
      if (typeof data.message === "string") return data.message
    }
    if (typeof rec.name === "string") return rec.name
  }
  try {
    const fallback = JSON.stringify(error)
    if (fallback === "{}" || fallback === "") return "unknown error"
    return fallback
  } catch {
    return String(error)
  }
}

/**
 * Adapts the v1 SDK client (which returns `{ data, error, request, response }`
 * tuples and does not throw on HTTP errors) to the `BridgeClient` contract:
 * plain data on success, thrown Error on failure.
 *
 * Also tolerates plain-data results (e.g. test mocks) so callers can pass
 * either shape.
 */
export function adaptClient(raw: unknown): BridgeClient {
  const call = async <T>(promise: Promise<unknown>): Promise<T> => {
    const result: unknown = await promise
    if (result && typeof result === "object") {
      const tuple = result as ResultLike
      if ("error" in tuple && tuple.error !== undefined && tuple.error !== null) {
        throw new Error(errorMessage(tuple.error))
      }
      if ("data" in tuple) return tuple.data as T
    }
    if (result === undefined) {
      // The tuple-shaped client never yields undefined on success (204
      // responses come back as { data: {} }). Undefined here means an error
      // was swallowed by a data-mode client; fail loudly instead.
      throw new Error("opencode client returned no data")
    }
    return result as T
  }

  const session = raw as {
    session: Record<string, (input: unknown) => Promise<unknown>>
  }
  const s = session.session

  return {
    session: {
      promptAsync: (input) => call(s.promptAsync(input)),
      messages: (input) => call(s.messages(input)),
      get: (input) => call(s.get(input)),
      status: (input) => call(s.status(input)),
      list: (input) => call(s.list(input)),
    },
  }
}
