import type { ProviderProfile } from "./provider-profile.js";
import type { UserConfig, UserSecretReference } from "./user-config.js";

export const FREE_API_PROVIDER = {
  id: "opencode-zen",
  name: "OpenCode Zen",
  baseURL: "https://opencode.ai/zen/v1",
  modelID: "deepseek-v4-flash-free",
  modelName: "deepseek-v4-flash-free",
  protocol: "chat-completions",
  apiKeyEnv: "OPENCODE_ZEN_API_KEY",
  capabilities: {
    streaming: "supported",
    toolCalling: "supported",
    reasoning: "unknown",
  },
} as const;

export const GROQ_FREE_API_PROVIDER = {
  id: "groq",
  name: "GroqCloud",
  baseURL: "https://api.groq.com/openai/v1",
  modelID: "qwen/qwen3.6-27b",
  modelName: "qwen/qwen3.6-27b",
  protocol: "chat-completions",
  apiKeyEnv: "GROQ_API_KEY",
  capabilities: {
    streaming: "unknown",
    toolCalling: "unknown",
    reasoning: "unknown",
  },
} as const;

export interface FreeApiMigrationResult {
  state: "migrated" | "already-current";
  config: UserConfig;
}

function retiredSolarProfile(config: UserConfig): boolean {
  const provider = config.provider;
  return provider.id === "upstage" &&
    provider.name === "Upstage" &&
    provider.baseURL === "https://api.upstage.ai/v1" &&
    (provider.modelID === "solar-open2" || provider.modelID === "solar-pro4") &&
    provider.modelName === provider.modelID &&
    provider.protocol === "chat-completions" &&
    provider.apiKeyEnv === "UPSTAGE_API_KEY";
}

export function isCurrentFreeApiConfig(config: UserConfig): boolean {
  const provider = config.provider;
  return provider.id === FREE_API_PROVIDER.id &&
    provider.name === FREE_API_PROVIDER.name &&
    provider.baseURL === FREE_API_PROVIDER.baseURL &&
    provider.modelID === FREE_API_PROVIDER.modelID &&
    provider.modelName === FREE_API_PROVIDER.modelName &&
    provider.protocol === FREE_API_PROVIDER.protocol &&
    provider.apiKeyEnv === FREE_API_PROVIDER.apiKeyEnv &&
    provider.capabilities?.streaming ===
      FREE_API_PROVIDER.capabilities.streaming &&
    provider.capabilities.toolCalling ===
      FREE_API_PROVIDER.capabilities.toolCalling &&
    provider.capabilities.reasoning ===
      FREE_API_PROVIDER.capabilities.reasoning &&
    provider.routing === undefined;
}

export function admittedFreeApiProfile(
  profile: ProviderProfile,
): "zen-deepseek-free" | "groq-free" | null {
  const matches = (
    expected: typeof FREE_API_PROVIDER | typeof GROQ_FREE_API_PROVIDER,
  ) =>
    profile.providerID === expected.id &&
    profile.providerName === expected.name &&
    profile.baseURL === expected.baseURL &&
    profile.modelID === expected.modelID &&
    profile.modelName === expected.modelName &&
    profile.protocol === expected.protocol &&
    profile.apiKeyEnv === expected.apiKeyEnv &&
    profile.capabilities.streaming === expected.capabilities.streaming &&
    profile.capabilities.toolCalling === expected.capabilities.toolCalling &&
    profile.capabilities.reasoning === expected.capabilities.reasoning &&
    profile.routing === null;
  if (matches(FREE_API_PROVIDER)) return "zen-deepseek-free";
  if (matches(GROQ_FREE_API_PROVIDER)) return "groq-free";
  return null;
}

/**
 * Replace only an exact retired Upstage/Solar profile. The caller supplies a
 * reference to an already-configured Zen key; no credential value is copied.
 */
export function migrateRetiredSolarConfig(
  config: UserConfig,
  configuredAt: string,
  secret: UserSecretReference,
): FreeApiMigrationResult {
  if (isCurrentFreeApiConfig(config)) {
    return { state: "already-current", config };
  }
  if (!retiredSolarProfile(config)) {
    throw new Error(
      "profile is neither an exact retired Upstage/Solar profile nor the current Zen DeepSeek free profile",
    );
  }
  return {
    state: "migrated",
    config: {
      ...config,
      provider: {
        ...FREE_API_PROVIDER,
        secret,
      },
      configuredAt,
    },
  };
}
