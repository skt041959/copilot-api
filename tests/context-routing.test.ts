import { describe, expect, it, mock, beforeEach, afterEach } from "bun:test"
import { Context } from "hono"

import { state } from "~/lib/state"
import { handleCompletion } from "~/routes/messages/handler"

const mockFallbackCompletion = mock(() => {
  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json" },
  })
})

const mockCreateChatCompletions = mock(() => {
  return { choices: [{ message: { content: "mock response" } }] }
})

const mockGetTokenCount = mock(() => {
  return { input: 100 }
})

await mock.module("~/routes/messages/fallback-handler", () => {
  return {
    handleFallbackAnthropicCompletion: mockFallbackCompletion,
  }
})

await mock.module("~/services/copilot/create-chat-completions", () => {
  return {
    createChatCompletions: mockCreateChatCompletions,
  }
})

await mock.module("~/lib/tokenizer", () => {
  return {
    getTokenCount: mockGetTokenCount,
  }
})

describe("Anthropic 1M Context Routing Logic", () => {
  beforeEach(() => {
    state.fallbackAnthropicBaseUrl = "https://api.anthropic.com"
    state.fallbackAnthropicApiKey = "sk-ant-test"
    mockFallbackCompletion.mockClear()
    mockCreateChatCompletions.mockClear()
  })

  afterEach(() => {
    state.fallbackAnthropicBaseUrl = undefined
    state.fallbackAnthropicApiKey = undefined
  })

  it("should route to Copilot normally when not asking for 1M context", async () => {
    const mockContext = {
      req: {
        json: () =>
          Promise.resolve({
            model: "claude-3-opus-20240229",
            messages: [{ role: "user", content: "Hi" }],
          }),
        header: (_key: string) => undefined,
      },
      json: (data: unknown) => data as Response,
    } as unknown as Context

    await handleCompletion(mockContext)

    expect(mockFallbackCompletion).not.toHaveBeenCalled()
    expect(mockCreateChatCompletions).toHaveBeenCalled()
  })

  it("should route to fallback Anthropic when 'anthropic-beta' header has 'context-1m'", async () => {
    const mockContext = {
      req: {
        json: () =>
          Promise.resolve({
            model: "claude-3-opus-20240229",
            messages: [
              { role: "user", content: "Process this large document..." },
            ],
          }),
        header: (key: string) => {
          if (key === "anthropic-beta") return "context-1m-2025-08-07"
          return undefined
        },
      },
      json: (data: unknown) => data as Response,
    } as unknown as Context

    await handleCompletion(mockContext)

    expect(mockFallbackCompletion).toHaveBeenCalled()
    expect(mockCreateChatCompletions).not.toHaveBeenCalled()
  })

  it("should route to fallback Anthropic when model explicitly contains '-1m'", async () => {
    const mockContext = {
      req: {
        json: () =>
          Promise.resolve({
            model: "claude-3-opus-20240229-1m",
            messages: [
              { role: "user", content: "Process this large document..." },
            ],
          }),
        header: (_key: string) => undefined,
      },
      json: (data: unknown) => data as Response,
    } as unknown as Context

    await handleCompletion(mockContext)

    expect(mockFallbackCompletion).toHaveBeenCalled()
    expect(mockCreateChatCompletions).not.toHaveBeenCalled()
  })

  it("should route to fallback Anthropic when token count exceeds 200k", async () => {
    mockGetTokenCount.mockImplementationOnce(() => ({ input: 200001 }))

    const mockContext = {
      req: {
        json: () =>
          Promise.resolve({
            model: "claude-3-opus-20240229",
            messages: [{ role: "user", content: "Super long prompt..." }],
          }),
        header: (_key: string) => undefined,
      },
      json: (data: unknown) => data as Response,
    } as unknown as Context

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    state.models = { data: [{ id: "claude-3-opus-20240229" } as any] }

    await handleCompletion(mockContext)

    expect(mockFallbackCompletion).toHaveBeenCalled()
    expect(mockCreateChatCompletions).not.toHaveBeenCalled()

    // cleanup
    state.models = undefined
  })
})
