import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import { handleFallbackAnthropicCompletion } from "./fallback-handler"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  const selectedModel = state.models?.data.find(
    (model) => model.id === openAIPayload.model,
  )

  let exceedsTokenLimit = false
  if (selectedModel) {
    const tokenCount = await getTokenCount(openAIPayload, selectedModel)
    if (tokenCount.input > 200000) {
      exceedsTokenLimit = true
    }
  }

  // Claude Code represents 1m models differently (e.g. claude-sonnet-4-... -> replaced, but original payload has it)
  // Or explicitly checking if user asked for a big context model.
  // Additionally, Anthropic API uses the `anthropic-beta: context-1m-2025-08-07` header to opt-in to 1M context.
  const anthropicBeta = c.req.header("anthropic-beta") || ""
  const isExtendedModel =
    anthropicPayload.model.includes("-1m") ||
    anthropicBeta.includes("context-1m")

  const useFallback =
    state.fallbackAnthropicBaseUrl
    && state.fallbackAnthropicApiKey
    && (isExtendedModel || exceedsTokenLimit)

  if (useFallback) {
    return handleFallbackAnthropicCompletion(c, anthropicPayload, {
      baseUrl: state.fallbackAnthropicBaseUrl as string,
      apiKey: state.fallbackAnthropicApiKey as string,
    })
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
