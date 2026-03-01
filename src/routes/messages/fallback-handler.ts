import type { Context } from "hono"

import consola from "consola"
import { events } from "fetch-event-stream"
import { streamSSE } from "hono/streaming"

import { HTTPError } from "~/lib/error"

import { type AnthropicMessagesPayload } from "./anthropic-types"

export async function handleFallbackAnthropicCompletion(
  c: Context,
  payload: AnthropicMessagesPayload,
  options: { baseUrl: string; apiKey: string },
) {
  const { baseUrl, apiKey } = options
  consola.info(`Routing request to fallback Anthropic API: ${baseUrl}`)

  const anthropicBeta = c.req.header("anthropic-beta")
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": c.req.header("anthropic-version") || "2023-06-01",
    "content-type": "application/json",
  }

  if (anthropicBeta) {
    headers["anthropic-beta"] = anthropicBeta
  }

  // Ensure url ends with /v1/messages
  let endpoint = baseUrl
  if (!baseUrl.endsWith("/v1/messages")) {
    endpoint =
      baseUrl.endsWith("/") ? `${baseUrl}v1/messages` : `${baseUrl}/v1/messages`
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to fetch from fallback Anthropic API", response)
    throw new HTTPError("Failed to fetch from fallback Anthropic API", response)
  }

  if (!payload.stream) {
    return c.json(await response.json())
  }

  consola.debug("Streaming response from fallback Anthropic API")
  return streamSSE(c, async (stream) => {
    const streamEvents = events(response)
    for await (const rawEvent of streamEvents) {
      if (!rawEvent.data) {
        continue
      }

      await stream.writeSSE({
        event: rawEvent.event || "message",
        data: rawEvent.data,
      })
    }
  })
}
