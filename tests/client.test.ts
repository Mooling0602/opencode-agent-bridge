import { describe, expect, it } from "vitest"
import { adaptClient } from "../src/client"

function tupleClient(overrides: Record<string, (input: unknown) => Promise<unknown>>) {
  const raw = { session: overrides }
  return adaptClient(raw)
}

describe("adaptClient", () => {
  it("unwraps { data } tuples", async () => {
    const client = tupleClient({
      list: async () => ({ data: [{ id: "ses_1", title: "标题" }], request: {}, response: {} }),
    })
    const result = await client.session.list({ query: {} })
    expect(result).toEqual([{ id: "ses_1", title: "标题" }])
  })

  it("unwraps empty data tuples (204 responses)", async () => {
    const client = tupleClient({
      promptAsync: async () => ({ data: {}, request: {}, response: {} }),
    })
    await expect(client.session.promptAsync({ path: { id: "x" }, body: { parts: [] } })).resolves.toEqual({})
  })

  it("throws on { error } tuples with a string error", async () => {
    const client = tupleClient({
      get: async () => ({ error: "session not found", request: {}, response: {} }),
    })
    await expect(client.session.get({ path: { id: "x" } })).rejects.toThrow("session not found")
  })

  it("throws on { error } tuples with an object error using message", async () => {
    const client = tupleClient({
      get: async () => ({ error: { name: "NotFoundError", message: "no such session" }, request: {}, response: {} }),
    })
    await expect(client.session.get({ path: { id: "x" } })).rejects.toThrow("no such session")
  })

  it("throws on { error } tuples with an object error using name", async () => {
    const client = tupleClient({
      get: async () => ({ error: { name: "NotFoundError" }, request: {}, response: {} }),
    })
    await expect(client.session.get({ path: { id: "x" } })).rejects.toThrow("NotFoundError")
  })

  it("extracts data.message from SDK NamedError wire shape", async () => {
    const client = tupleClient({
      get: async () => ({
        error: { name: "NotFoundError", data: { message: "session does not exist" } },
        request: {},
        response: {},
      }),
    })
    await expect(client.session.get({ path: { id: "x" } })).rejects.toThrow("session does not exist")
  })

  it("falls back to a generic message for empty error bodies", async () => {
    const client = tupleClient({
      get: async () => ({ error: {}, request: {}, response: {} }),
    })
    await expect(client.session.get({ path: { id: "x" } })).rejects.toThrow("unknown error")
  })

  it("throws on undefined results (data-mode swallowed errors)", async () => {
    const client = tupleClient({
      list: async () => undefined,
    })
    await expect(client.session.list({ query: {} })).rejects.toThrow("returned no data")
  })

  it("passes plain data through untouched (mock-friendly)", async () => {
    const client = tupleClient({
      list: async () => [{ id: "ses_1", title: "标题" }],
      promptAsync: async () => ({}),
    })
    expect(await client.session.list({ query: {} })).toEqual([{ id: "ses_1", title: "标题" }])
    await expect(client.session.promptAsync({ path: { id: "x" }, body: { parts: [] } })).resolves.toEqual({})
  })

  it("propagates rejected promises", async () => {
    const client = tupleClient({
      messages: async () => {
        throw new Error("network down")
      },
    })
    await expect(client.session.messages({ path: { id: "x" } })).rejects.toThrow("network down")
  })

  it("does not treat falsy error values as failures", async () => {
    const client = tupleClient({
      get: async () => ({ data: { id: "x", title: "ok" }, error: null, request: {}, response: {} }),
    })
    await expect(client.session.get({ path: { id: "x" } })).resolves.toEqual({ id: "x", title: "ok" })
  })
})
