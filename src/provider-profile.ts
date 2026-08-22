export const DEFAULT_API_KEY_ENV = "ORGANUM_CODE_API_KEY";

export const ROLES = [
  "implementer",
  "reviewer",
  "critic",
  "researcher",
] as const;

export type Role = (typeof ROLES)[number];
export type ProviderProtocol = "chat-completions" | "responses";
export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export interface ModelCapabilityProfile {
  streaming: CapabilitySupport;
  toolCalling: CapabilitySupport;
  reasoning: CapabilitySupport;
}

export interface OpenRouterMaxPrice {
  prompt?: number;
  completion?: number;
  request?: number;
  image?: number;
}

export interface OpenRouterRoutingProfile {
  kind: "openrouter";
  fallbackModels: readonly string[];
  providerOrder: readonly string[];
  sort: "price" | "throughput" | "latency" | null;
  allowFallbacks: boolean | null;
  requireParameters: boolean | null;
  dataCollection: "allow" | "deny" | null;
  zeroDataRetention: boolean | null;
  maxPrice: OpenRouterMaxPrice | null;
  referer: string | null;
  title: string | null;
}

export type ProviderRoutingProfile = OpenRouterRoutingProfile;

export interface ProviderProfile {
  providerID: string;
  providerName: string;
  modelID: string;
  modelName: string;
  baseURL: string;
  apiKeyEnv: string;
  protocol: ProviderProtocol;
  capabilities: ModelCapabilityProfile;
  routing: ProviderRoutingProfile | null;
  role: Role;
}

export interface LoadProviderProfileOptions {
  requireApiKey?: boolean;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`${name} is required`);
  }
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return env[name]?.trim() || fallback;
}

function parseProviderID(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    throw new ConfigurationError(
      "ORGANUM_CODE_PROVIDER_ID must use lowercase letters, numbers, dots, underscores, or hyphens",
    );
  }
  return value;
}

function parseEnvironmentName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new ConfigurationError(
      "ORGANUM_CODE_API_KEY_ENV must be a valid environment variable name",
    );
  }
  return value;
}

function parseBaseURL(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("ORGANUM_CODE_BASE_URL must be an absolute URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigurationError("ORGANUM_CODE_BASE_URL must use http or https");
  }
  if (url.username || url.password) {
    throw new ConfigurationError("ORGANUM_CODE_BASE_URL must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new ConfigurationError(
      "ORGANUM_CODE_BASE_URL must not contain a query string or fragment",
    );
  }

  return value.replace(/\/+$/, "");
}

function parseRole(value: string): Role {
  if (!ROLES.includes(value as Role)) {
    throw new ConfigurationError(
      `ORGANUM_CODE_ROLE must be one of: ${ROLES.join(", ")}`,
    );
  }
  return value as Role;
}

function parseProtocol(value: string): ProviderProtocol {
  if (value !== "chat-completions" && value !== "responses") {
    throw new ConfigurationError(
      "ORGANUM_CODE_PROTOCOL must be chat-completions or responses",
    );
  }
  return value;
}

function parseCapability(name: string, value: string): CapabilitySupport {
  if (value !== "supported" && value !== "unsupported" && value !== "unknown") {
    throw new ConfigurationError(
      `${name} must be supported, unsupported, or unknown`,
    );
  }
  return value;
}

function parseOptionalBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | null {
  const value = env[name]?.trim();
  if (!value) return null;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigurationError(`${name} must be true or false`);
}

function parseList(
  env: NodeJS.ProcessEnv,
  name: string,
  maximum: number,
): string[] {
  const value = env[name]?.trim();
  if (!value) return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (
    entries.some((entry) => entry.length === 0 || /\s/.test(entry)) ||
    new Set(entries).size !== entries.length
  ) {
    throw new ConfigurationError(
      `${name} must be a comma-separated list of unique IDs without whitespace`,
    );
  }
  if (entries.length > maximum) {
    throw new ConfigurationError(`${name} supports at most ${maximum} entries`);
  }
  return entries;
}

function parseOptionalPrice(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000) {
    throw new ConfigurationError(
      `${name} must be a finite number between 0 and 1000000`,
    );
  }
  return parsed;
}

function parseOptionalReferer(env: NodeJS.ProcessEnv): string | null {
  const value = env.ORGANUM_CODE_OPENROUTER_REFERER?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(
      "ORGANUM_CODE_OPENROUTER_REFERER must be an absolute URL",
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new ConfigurationError(
      "ORGANUM_CODE_OPENROUTER_REFERER must be an http(s) URL without credentials",
    );
  }
  return value;
}

function parseOptionalTitle(env: NodeJS.ProcessEnv): string | null {
  const value = env.ORGANUM_CODE_OPENROUTER_TITLE?.trim();
  if (!value) return null;
  if (value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ConfigurationError(
      "ORGANUM_CODE_OPENROUTER_TITLE must be at most 128 printable characters",
    );
  }
  return value;
}

const ROUTING_ENV_NAMES = [
  "ORGANUM_CODE_ROUTING_FALLBACK_MODELS",
  "ORGANUM_CODE_ROUTING_PROVIDER_ORDER",
  "ORGANUM_CODE_ROUTING_SORT",
  "ORGANUM_CODE_ROUTING_ALLOW_FALLBACKS",
  "ORGANUM_CODE_ROUTING_REQUIRE_PARAMETERS",
  "ORGANUM_CODE_ROUTING_DATA_COLLECTION",
  "ORGANUM_CODE_ROUTING_ZDR",
  "ORGANUM_CODE_ROUTING_MAX_PROMPT_PRICE",
  "ORGANUM_CODE_ROUTING_MAX_COMPLETION_PRICE",
  "ORGANUM_CODE_ROUTING_MAX_REQUEST_PRICE",
  "ORGANUM_CODE_ROUTING_MAX_IMAGE_PRICE",
  "ORGANUM_CODE_OPENROUTER_REFERER",
  "ORGANUM_CODE_OPENROUTER_TITLE",
] as const;

function parseRouting(
  env: NodeJS.ProcessEnv,
  modelID: string,
  protocol: ProviderProtocol,
): ProviderRoutingProfile | null {
  const kind = env.ORGANUM_CODE_ROUTING_KIND?.trim();
  if (!kind) {
    if (ROUTING_ENV_NAMES.some((name) => env[name]?.trim())) {
      throw new ConfigurationError(
        "ORGANUM_CODE_ROUTING_KIND is required when routing options are set",
      );
    }
    return null;
  }
  if (kind !== "openrouter") {
    throw new ConfigurationError(
      "ORGANUM_CODE_ROUTING_KIND currently supports only openrouter",
    );
  }

  const fallbackModels = parseList(
    env,
    "ORGANUM_CODE_ROUTING_FALLBACK_MODELS",
    8,
  );
  if (fallbackModels.includes(modelID)) {
    throw new ConfigurationError(
      "ORGANUM_CODE_ROUTING_FALLBACK_MODELS must not repeat the primary model",
    );
  }
  const providerOrder = parseList(
    env,
    "ORGANUM_CODE_ROUTING_PROVIDER_ORDER",
    16,
  );
  const sortValue = env.ORGANUM_CODE_ROUTING_SORT?.trim() || null;
  if (
    sortValue !== null &&
    sortValue !== "price" &&
    sortValue !== "throughput" &&
    sortValue !== "latency"
  ) {
    throw new ConfigurationError(
      "ORGANUM_CODE_ROUTING_SORT must be price, throughput, or latency",
    );
  }
  const dataCollection =
    env.ORGANUM_CODE_ROUTING_DATA_COLLECTION?.trim() || null;
  if (
    dataCollection !== null &&
    dataCollection !== "allow" &&
    dataCollection !== "deny"
  ) {
    throw new ConfigurationError(
      "ORGANUM_CODE_ROUTING_DATA_COLLECTION must be allow or deny",
    );
  }
  const maxPrice: OpenRouterMaxPrice = {
    prompt: parseOptionalPrice(env, "ORGANUM_CODE_ROUTING_MAX_PROMPT_PRICE"),
    completion: parseOptionalPrice(
      env,
      "ORGANUM_CODE_ROUTING_MAX_COMPLETION_PRICE",
    ),
    request: parseOptionalPrice(env, "ORGANUM_CODE_ROUTING_MAX_REQUEST_PRICE"),
    image: parseOptionalPrice(env, "ORGANUM_CODE_ROUTING_MAX_IMAGE_PRICE"),
  };
  const boundedPrice = Object.values(maxPrice).some((value) => value !== undefined)
    ? maxPrice
    : null;
  const routing: OpenRouterRoutingProfile = {
    kind,
    fallbackModels,
    providerOrder,
    sort: sortValue,
    allowFallbacks: parseOptionalBoolean(
      env,
      "ORGANUM_CODE_ROUTING_ALLOW_FALLBACKS",
    ),
    requireParameters: parseOptionalBoolean(
      env,
      "ORGANUM_CODE_ROUTING_REQUIRE_PARAMETERS",
    ),
    dataCollection,
    zeroDataRetention: parseOptionalBoolean(env, "ORGANUM_CODE_ROUTING_ZDR"),
    maxPrice: boundedPrice,
    referer: parseOptionalReferer(env),
    title: parseOptionalTitle(env),
  };
  const hasChatBodyPolicy =
    routing.fallbackModels.length > 0 ||
    routing.providerOrder.length > 0 ||
    routing.sort !== null ||
    routing.allowFallbacks !== null ||
    routing.requireParameters !== null ||
    routing.dataCollection !== null ||
    routing.zeroDataRetention !== null ||
    routing.maxPrice !== null;
  if (protocol === "responses" && hasChatBodyPolicy) {
    throw new ConfigurationError(
      "OpenRouter body routing currently requires chat-completions; direct Responses may only set attribution headers",
    );
  }
  return routing;
}

export function loadProviderProfile(
  env: NodeJS.ProcessEnv,
  options: LoadProviderProfileOptions = {},
): ProviderProfile {
  const apiKeyEnv = parseEnvironmentName(
    optional(env, "ORGANUM_CODE_API_KEY_ENV", DEFAULT_API_KEY_ENV),
  );
  if (options.requireApiKey !== false) required(env, apiKeyEnv);

  const modelID = required(env, "ORGANUM_CODE_MODEL");
  if (/\s/.test(modelID)) {
    throw new ConfigurationError("ORGANUM_CODE_MODEL must not contain whitespace");
  }

  const protocol = parseProtocol(
    optional(env, "ORGANUM_CODE_PROTOCOL", "chat-completions"),
  );
  return {
    providerID: parseProviderID(
      optional(env, "ORGANUM_CODE_PROVIDER_ID", "organum-brain"),
    ),
    providerName: optional(env, "ORGANUM_CODE_PROVIDER_NAME", "Organum Brain"),
    modelID,
    modelName: optional(env, "ORGANUM_CODE_MODEL_NAME", modelID),
    baseURL: parseBaseURL(required(env, "ORGANUM_CODE_BASE_URL")),
    apiKeyEnv,
    protocol,
    capabilities: {
      streaming: parseCapability(
        "ORGANUM_CODE_CAPABILITY_STREAMING",
        optional(env, "ORGANUM_CODE_CAPABILITY_STREAMING", "unknown"),
      ),
      toolCalling: parseCapability(
        "ORGANUM_CODE_CAPABILITY_TOOL_CALLING",
        optional(env, "ORGANUM_CODE_CAPABILITY_TOOL_CALLING", "unknown"),
      ),
      reasoning: parseCapability(
        "ORGANUM_CODE_CAPABILITY_REASONING",
        optional(env, "ORGANUM_CODE_CAPABILITY_REASONING", "unknown"),
      ),
    },
    routing: parseRouting(env, modelID, protocol),
    role: parseRole(optional(env, "ORGANUM_CODE_ROLE", "implementer")),
  };
}
