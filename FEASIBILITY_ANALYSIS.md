# Feasibility Analysis and Implementation Plan: Routing Anthropic API Requests based on Context Length

## Overview
This document analyzes the feasibility and outlines an implementation plan for dynamically routing incoming Anthropic API requests either to the standard GitHub Copilot API or to an alternative Anthropics-compatible API backend (such as the official Anthropic API).

The routing condition depends on two main factors:
1. **Explicit Client Model Selection:** If the client explicitly chooses a model denoting a large context window, such as `opus[1m]` or `sonnet[1m]`.
2. **Context Length Threshold:** If the calculated input context exceeds a specific threshold, specifically 200,000 tokens.

When these conditions are met, the proxy will bypass the Copilot API endpoint and directly forward the `messages` request to the provided `anthropic-base-url` using a designated `anthropic-api-key`.

## Feasibility Analysis

### 1. Can we differentiate the `[1m]` models in the API Request?
**Feasible.** Claude Code maps the UI selection (e.g. `opus[1m]`) to specific model string formats in its API requests (e.g., `claude-opus-4-...` or `claude-3-7-sonnet-20250219`). In `src/routes/messages/non-stream-translation.ts`, there is already logic to rewrite subagent model strings back to standardized Copilot-supported models. We can simply inspect `anthropicPayload.model` in `handleCompletion` before it gets rewritten. If it indicates an extended context or explicitly asks for an opus/sonnet 1m context, we can flag this request for alternative routing.

### 2. Can we calculate the Token Context Length?
**Feasible.** The codebase currently calculates context length for Anthropic tokens accurately via the `getTokenCount` method from `src/lib/tokenizer.ts`, which correctly leverages `gpt-tokenizer` with model-specific token logic. This function is currently used in `count-tokens-handler.ts`. We can reuse this function in `handleCompletion` (or a middleware before it) to calculate the request's input tokens. If `inputTokens > 200,000`, the request can be rerouted.

### 3. Can we supply an alternative Base URL and API Key?
**Feasible.** We can extend the global proxy `state` (defined in `src/lib/state.ts`) to accept two new optional parameters: `fallbackAnthropicBaseUrl` and `fallbackAnthropicApiKey`. We can expose CLI flags (e.g., `--fallback-anthropic-base-url` and `--fallback-anthropic-api-key`) in the `start` command to populate these state parameters.

### 4. Can we seamlessly route to the alternative Anthropic API?
**Feasible.** The Anthropic API's `/v1/messages` endpoint accepts exactly the payload format we receive in `anthropicPayload` (of type `AnthropicMessagesPayload`). When routing to the fallback API:
- We **do not** need to translate the payload to the OpenAI format via `translateToOpenAI`.
- We **do not** need to translate the response back from OpenAI to Anthropic.
- We can simply proxy the request (JSON body, headers including the fallback API key) to the `fallbackAnthropicBaseUrl`, stream the response chunk-by-chunk directly to the client without translation, or parse and return the non-streaming JSON directly.

### Conclusion on Feasibility
The requirement is completely feasible and integrates elegantly into the existing proxy architecture without causing significant disruption to the existing Copilot endpoints.

---

## Implementation Plan

### Step 1: Extend CLI and State Management
Modify `src/lib/state.ts` and `src/start.ts` to accept the alternative Anthropic API routing settings.
1. In `src/lib/state.ts`, add:
   ```typescript
   fallbackAnthropicBaseUrl?: string
   fallbackAnthropicApiKey?: string
   ```
2. In `src/start.ts` (or the respective CLI definition file), add command-line options:
   - `--fallback-anthropic-url`
   - `--fallback-anthropic-key`
3. Map these CLI arguments to the `state` object when initializing the server.

### Step 2: Implement Context Length Calculation in Handler
In `src/routes/messages/handler.ts` (inside `handleCompletion`), calculate the input token count before translation.
1. Identify the requested model using `state.models?.data.find(...)`. If not found, default to a standard model for token counting.
2. Call `getTokenCount(translateToOpenAI(anthropicPayload), selectedModel)` to obtain `tokenCount.input`.
3. Check the `anthropicPayload.model` name directly.

### Step 3: Implement Routing Logic
In `src/routes/messages/handler.ts`, implement the decision branch.
```typescript
const isExtendedModel = anthropicPayload.model.includes("-1m") || anthropicPayload.model.includes("opus-") // Adjust matching logic based on exact Claude Code model strings
const exceedsTokenLimit = tokenCount.input > 200000;
const useFallback = state.fallbackAnthropicBaseUrl && state.fallbackAnthropicApiKey && (isExtendedModel || exceedsTokenLimit);

if (useFallback) {
   // Forward request to fallback Anthropic API
   return handleFallbackAnthropicCompletion(c, anthropicPayload, state.fallbackAnthropicBaseUrl, state.fallbackAnthropicApiKey);
} else {
   // Continue with existing Copilot logic (translateToOpenAI, etc.)
}
```

### Step 4: Implement `handleFallbackAnthropicCompletion`
Create a new function to handle forwarding directly to the alternative Anthropic API.
1. This function will make a `fetch` request to `${fallbackAnthropicBaseUrl}/v1/messages` (or the provided path).
2. Attach necessary headers: `x-api-key: <fallbackAnthropicApiKey>`, `anthropic-version`, and standard JSON content types.
3. Pass `anthropicPayload` as the JSON body string.
4. Handle the response:
   - If `anthropicPayload.stream` is true, stream the raw SSE response back to the client natively using `streamSSE` but piping the raw events without any translation since it's already in the Anthropic format.
   - If false, await the JSON response and return it directly.

### Step 5: Testing and Refinement
1. Verify token calculation performance and ensure it does not significantly increase latency for standard requests.
2. Test fallback routing using dummy base URLs to verify headers and payloads are preserved.
3. Confirm stream forwarding works flawlessly by reading Anthropic streams and directly piping them out.
