import type {
  InferenceBrokerMode,
  InferenceBrokerRequestTransform,
  JsonObject,
} from "./inference-broker.js";
import {
  ConfigurationError,
  type OpenRouterRoutingProfile,
  type ProviderProfile,
} from "./provider-profile.js";

export interface ProviderBrokerPolicy {
  requestTransform?: InferenceBrokerRequestTransform;
  upstreamHeaders?: Readonly<Record<string, string>>;
}

function chatUpstream(mode: InferenceBrokerMode): boolean {
  return mode === "chat-completions" || mode.endsWith("to-chat-completions");
}

function openRouterProviderObject(
  routing: OpenRouterRoutingProfile,
): JsonObject | null {
  const provider: JsonObject = {};
  if (routing.providerOrder.length > 0) provider.order = [...routing.providerOrder];
  if (routing.sort !== null) provider.sort = routing.sort;
  if (routing.allowFallbacks !== null) {
    provider.allow_fallbacks = routing.allowFallbacks;
  }
  if (routing.requireParameters !== null) {
    provider.require_parameters = routing.requireParameters;
  }
  if (routing.dataCollection !== null) {
    provider.data_collection = routing.dataCollection;
  }
  if (routing.zeroDataRetention !== null) {
    provider.zdr = routing.zeroDataRetention;
  }
  if (routing.maxPrice !== null) {
    provider.max_price = { ...routing.maxPrice };
  }
  return Object.keys(provider).length > 0 ? provider : null;
}

function openRouterRequestTransform(
  profile: ProviderProfile,
  mode: InferenceBrokerMode,
): InferenceBrokerRequestTransform {
  const routing = profile.routing!;
  return (body) => {
    const transformed: JsonObject = { ...body };

    // These fields can redirect a request away from the broker-bound model.
    // The broker owns them even when no fallback/routing preference is set.
    delete transformed.provider;
    delete transformed.models;
    delete transformed.fallbacks;

    if (!chatUpstream(mode)) return transformed;
    const provider = openRouterProviderObject(routing);
    if (provider !== null) transformed.provider = provider;
    if (routing.fallbackModels.length > 0) {
      // OpenRouter treats `model` as the primary and `models` as ordered
      // fallbacks when both are present.
      transformed.models = [...routing.fallbackModels];
    }
    return transformed;
  };
}

function groqQwenRequestTransform(
  body: Readonly<JsonObject>,
): JsonObject {
  return {
    ...body,
    // Qwen 3.6 defaults to raw <think> content. Groq requires parsed or
    // hidden reasoning for tool calls, and recommends retaining only final
    // outputs in multi-turn history. Keep reasoning enabled but out of the
    // assistant content reconstructed by the Responses bridge.
    reasoning_format: "hidden",
  };
}

function opencodeZenDeepSeekV4RequestTransform(
  body: Readonly<JsonObject>,
): JsonObject {
  const transformed: JsonObject = { ...body };
  if (
    Array.isArray(body.tools) &&
    body.tools.length > 0 &&
    body.tool_choice === "auto"
  ) {
    // DeepSeek V4 defaults to thinking mode. Its agent integration contract
    // rejects tool_choice in that mode, while OpenCode 1.18.3 emits `auto` for
    // every tool-capable turn. Omitting `auto` preserves the same default
    // selection semantics and leaves reasoning_content replay to OpenCode,
    // which preserves it together with non-null assistant content.
    delete transformed.tool_choice;
  }
  return transformed;
}

export function providerBrokerPolicy(
  profile: ProviderProfile,
  mode: InferenceBrokerMode,
): ProviderBrokerPolicy {
  if (
    profile.providerID === "opencode-zen" &&
    profile.modelID === "deepseek-v4-flash-free" &&
    chatUpstream(mode)
  ) {
    return { requestTransform: opencodeZenDeepSeekV4RequestTransform };
  }
  if (
    profile.providerID === "groq" &&
    profile.modelID === "qwen/qwen3.6-27b" &&
    chatUpstream(mode)
  ) {
    return { requestTransform: groqQwenRequestTransform };
  }
  if (profile.routing?.kind !== "openrouter") return {};
  const headers: Record<string, string> = {};
  if (profile.routing.referer !== null) {
    headers["HTTP-Referer"] = profile.routing.referer;
  }
  if (profile.routing.title !== null) {
    headers["X-OpenRouter-Title"] = profile.routing.title;
  }
  return {
    requestTransform: openRouterRequestTransform(profile, mode),
    ...(Object.keys(headers).length === 0 ? {} : { upstreamHeaders: headers }),
  };
}

export function assertCodingModelCapabilities(
  profile: Pick<ProviderProfile, "capabilities" | "modelID">,
): void {
  if (profile.capabilities.streaming === "unsupported") {
    throw new ConfigurationError(
      `Model ${profile.modelID} is declared incompatible with streaming coding backends`,
    );
  }
  if (profile.capabilities.toolCalling === "unsupported") {
    throw new ConfigurationError(
      `Model ${profile.modelID} is declared incompatible with coding tool calls`,
    );
  }
}
