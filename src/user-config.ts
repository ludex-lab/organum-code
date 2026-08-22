import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  ConfigurationError,
  loadProviderProfile,
  type CapabilitySupport,
  type ModelCapabilityProfile,
  type OpenRouterMaxPrice,
  type ProviderRoutingProfile,
  type ProviderProtocol,
} from "./provider-profile.js";

export const USER_CONFIG_SCHEMA = "organum-code/user-config/v1" as const;

export type ConfiguredBackend =
  | "claude"
  | "opencode"
  | "grok"
  | "deepcode"
  | "codex"
  | "cursor";

export type UserSecretReference =
  | { source: "environment" }
  | { source: "dotenv"; path: string }
  | { source: "keychain"; service: string; account: string };

export interface UserConfig {
  schema: typeof USER_CONFIG_SCHEMA;
  provider: {
    id: string;
    name: string;
    baseURL: string;
    modelID: string;
    modelName: string;
    protocol: ProviderProtocol;
    apiKeyEnv: string;
    capabilities?: ModelCapabilityProfile;
    routing?: ProviderRoutingProfile;
    secret: UserSecretReference;
  };
  backend: {
    default: ConfiguredBackend;
  };
  configuredAt: string;
}

const MAX_CONFIG_BYTES = 64 * 1024;
const BACKENDS = new Set<ConfiguredBackend>([
  "claude",
  "opencode",
  "grok",
  "deepcode",
  "codex",
  "cursor",
]);

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${context} must be a non-empty string`);
  }
  if (value.includes("\0")) {
    throw new ConfigurationError(`${context} must not contain NUL`);
  }
  return value;
}

function parseSecretReference(value: unknown): UserSecretReference {
  const secret = record(value, "provider.secret");
  const source = text(secret.source, "provider.secret.source");
  if (source === "environment") return { source };
  if (source === "dotenv") {
    const path = text(secret.path, "provider.secret.path");
    if (!isAbsolute(path)) {
      throw new ConfigurationError("provider.secret.path must be absolute");
    }
    return { source, path };
  }
  if (source === "keychain") {
    return {
      source,
      service: text(secret.service, "provider.secret.service"),
      account: text(secret.account, "provider.secret.account"),
    };
  }
  throw new ConfigurationError(
    "provider.secret.source must be environment, dotenv, or keychain",
  );
}

function capability(value: unknown, context: string): CapabilitySupport {
  if (value !== "supported" && value !== "unsupported" && value !== "unknown") {
    throw new ConfigurationError(
      `${context} must be supported, unsupported, or unknown`,
    );
  }
  return value;
}

function parseCapabilities(value: unknown): ModelCapabilityProfile {
  const capabilities = record(value, "provider.capabilities");
  return {
    streaming: capability(
      capabilities.streaming,
      "provider.capabilities.streaming",
    ),
    toolCalling: capability(
      capabilities.toolCalling,
      "provider.capabilities.toolCalling",
    ),
    reasoning: capability(
      capabilities.reasoning,
      "provider.capabilities.reasoning",
    ),
  };
}

function optionalStringArray(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ConfigurationError(`${context} must be an array`);
  }
  return value.map((entry, index) => text(entry, `${context}[${index}]`));
}

function optionalNullableBoolean(value: unknown, context: string): boolean | null {
  if (value === null) return null;
  if (typeof value !== "boolean") {
    throw new ConfigurationError(`${context} must be a boolean or null`);
  }
  return value;
}

function optionalNullableText(value: unknown, context: string): string | null {
  return value === null ? null : text(value, context);
}

function parseMaxPrice(value: unknown): OpenRouterMaxPrice | null {
  if (value === null) return null;
  const price = record(value, "provider.routing.maxPrice");
  const result: OpenRouterMaxPrice = {};
  for (const field of ["prompt", "completion", "request", "image"] as const) {
    const amount = price[field];
    if (amount === undefined) continue;
    if (typeof amount !== "number") {
      throw new ConfigurationError(
        `provider.routing.maxPrice.${field} must be a number`,
      );
    }
    result[field] = amount;
  }
  return result;
}

function parseRouting(value: unknown): ProviderRoutingProfile {
  const routing = record(value, "provider.routing");
  if (routing.kind !== "openrouter") {
    throw new ConfigurationError(
      "provider.routing.kind currently supports only openrouter",
    );
  }
  const sort = routing.sort;
  if (
    sort !== null &&
    sort !== "price" &&
    sort !== "throughput" &&
    sort !== "latency"
  ) {
    throw new ConfigurationError(
      "provider.routing.sort must be price, throughput, latency, or null",
    );
  }
  const dataCollection = routing.dataCollection;
  if (
    dataCollection !== null &&
    dataCollection !== "allow" &&
    dataCollection !== "deny"
  ) {
    throw new ConfigurationError(
      "provider.routing.dataCollection must be allow, deny, or null",
    );
  }
  return {
    kind: "openrouter",
    fallbackModels: optionalStringArray(
      routing.fallbackModels,
      "provider.routing.fallbackModels",
    ),
    providerOrder: optionalStringArray(
      routing.providerOrder,
      "provider.routing.providerOrder",
    ),
    sort,
    allowFallbacks: optionalNullableBoolean(
      routing.allowFallbacks,
      "provider.routing.allowFallbacks",
    ),
    requireParameters: optionalNullableBoolean(
      routing.requireParameters,
      "provider.routing.requireParameters",
    ),
    dataCollection,
    zeroDataRetention: optionalNullableBoolean(
      routing.zeroDataRetention,
      "provider.routing.zeroDataRetention",
    ),
    maxPrice: parseMaxPrice(routing.maxPrice),
    referer: optionalNullableText(routing.referer, "provider.routing.referer"),
    title: optionalNullableText(routing.title, "provider.routing.title"),
  };
}

export function parseUserConfig(value: unknown): UserConfig {
  const root = record(value, "User config");
  if (root.schema !== USER_CONFIG_SCHEMA) {
    throw new ConfigurationError(
      `User config schema must be ${USER_CONFIG_SCHEMA}`,
    );
  }
  const provider = record(root.provider, "provider");
  const backend = record(root.backend, "backend");
  const defaultBackend = text(backend.default, "backend.default");
  if (!BACKENDS.has(defaultBackend as ConfiguredBackend)) {
    throw new ConfigurationError(
      "backend.default must be claude, opencode, grok, deepcode, codex, or cursor",
    );
  }

  const candidate: UserConfig = {
    schema: USER_CONFIG_SCHEMA,
    provider: {
      id: text(provider.id, "provider.id"),
      name: text(provider.name, "provider.name"),
      baseURL: text(provider.baseURL, "provider.baseURL"),
      modelID: text(provider.modelID, "provider.modelID"),
      modelName: text(provider.modelName, "provider.modelName"),
      protocol: text(provider.protocol, "provider.protocol") as ProviderProtocol,
      apiKeyEnv: text(provider.apiKeyEnv, "provider.apiKeyEnv"),
      ...(provider.capabilities === undefined
        ? {}
        : { capabilities: parseCapabilities(provider.capabilities) }),
      ...(provider.routing === undefined
        ? {}
        : { routing: parseRouting(provider.routing) }),
      secret: parseSecretReference(provider.secret),
    },
    backend: { default: defaultBackend as ConfiguredBackend },
    configuredAt: text(root.configuredAt, "configuredAt"),
  };

  // Reuse the launch-time parser so persisted values and environment values
  // cannot drift into two subtly different contracts.
  loadProviderProfile(configToEnvironment(candidate, {}), {
    requireApiKey: false,
  });
  if (Number.isNaN(Date.parse(candidate.configuredAt))) {
    throw new ConfigurationError("configuredAt must be an ISO date-time");
  }
  return candidate;
}

export function resolveUserConfigPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir(),
): string {
  const explicit = env.ORGANUM_CODE_CONFIG_FILE?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new ConfigurationError("ORGANUM_CODE_CONFIG_FILE must be absolute");
    }
    return resolve(explicit);
  }
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) {
    if (!isAbsolute(xdg)) {
      throw new ConfigurationError("XDG_CONFIG_HOME must be absolute");
    }
    return join(xdg, "organum-code", "config.json");
  }
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (appData && isAbsolute(appData)) {
      return join(appData, "organum-code", "config.json");
    }
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || fallbackHome;
  if (!home || !isAbsolute(home)) {
    throw new ConfigurationError("Unable to resolve the user config directory");
  }
  return join(home, ".config", "organum-code", "config.json");
}

export function normalizeUserProfileName(value: string): string {
  const profile = value.trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(profile) ||
    profile.endsWith(".")
  ) {
    throw new ConfigurationError(
      "Profile name must be 1-40 ASCII letters, numbers, dots, underscores, or hyphens; it must start with a letter/number and not end with a dot",
    );
  }
  return profile;
}

export function resolveProfileConfigPath(
  env: NodeJS.ProcessEnv,
  profile: string | undefined,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir(),
): string {
  if (profile === undefined) {
    return resolveUserConfigPath(env, platform, fallbackHome);
  }
  if (env.ORGANUM_CODE_CONFIG_FILE?.trim()) {
    throw new ConfigurationError(
      "--profile and ORGANUM_CODE_CONFIG_FILE are mutually exclusive",
    );
  }
  const normalized = normalizeUserProfileName(profile);
  const defaultPath = resolveUserConfigPath(env, platform, fallbackHome);
  return join(dirname(defaultPath), "profiles", normalized, "config.json");
}

export function defaultSecretFilePath(
  providerID: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(
    dirname(resolveUserConfigPath(env, platform)),
    `${providerID}.env`,
  );
}

export async function loadUserConfig(
  path: string,
): Promise<UserConfig | null> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ConfigurationError(
      "User config must be a regular non-symlink file",
    );
  }
  if (metadata.size > MAX_CONFIG_BYTES) {
    throw new ConfigurationError("User config is too large");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigurationError("User config is not valid JSON");
    }
    throw error;
  }
  return parseUserConfig(decoded);
}

async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const priorDirectory = await lstat(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (priorDirectory === null && process.platform !== "win32") {
    await chmod(directory, 0o700);
  }
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    existing !== null &&
    (!existing.isFile() || existing.isSymbolicLink())
  ) {
    throw new ConfigurationError(
      `${path} must be a regular non-symlink file`,
    );
  }
  const temporary = join(directory, `.organum-code-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function saveUserConfig(
  path: string,
  config: UserConfig,
): Promise<void> {
  const validated = parseUserConfig(config);
  await atomicPrivateWrite(path, `${JSON.stringify(validated, null, 2)}\n`);
}

function secretEnvironment(reference: UserSecretReference): NodeJS.ProcessEnv {
  if (reference.source === "environment") {
    return { ORGANUM_CODE_SECRET_SOURCE: "environment" };
  }
  if (reference.source === "dotenv") {
    return {
      ORGANUM_CODE_SECRET_SOURCE: "dotenv",
      ORGANUM_CODE_SECRET_FILE: reference.path,
    };
  }
  return {
    ORGANUM_CODE_SECRET_SOURCE: "keychain",
    ORGANUM_CODE_KEYCHAIN_SERVICE: reference.service,
    ORGANUM_CODE_KEYCHAIN_ACCOUNT: reference.account,
  };
}

function capabilityEnvironment(
  capabilities: ModelCapabilityProfile | undefined,
): NodeJS.ProcessEnv {
  if (capabilities === undefined) return {};
  return {
    ORGANUM_CODE_CAPABILITY_STREAMING: capabilities.streaming,
    ORGANUM_CODE_CAPABILITY_TOOL_CALLING: capabilities.toolCalling,
    ORGANUM_CODE_CAPABILITY_REASONING: capabilities.reasoning,
  };
}

function routingEnvironment(
  routing: ProviderRoutingProfile | undefined,
): NodeJS.ProcessEnv {
  if (routing === undefined) return {};
  return {
    ORGANUM_CODE_ROUTING_KIND: routing.kind,
    ORGANUM_CODE_ROUTING_FALLBACK_MODELS: routing.fallbackModels.join(","),
    ORGANUM_CODE_ROUTING_PROVIDER_ORDER: routing.providerOrder.join(","),
    ...(routing.sort === null ? {} : { ORGANUM_CODE_ROUTING_SORT: routing.sort }),
    ...(routing.allowFallbacks === null
      ? {}
      : {
          ORGANUM_CODE_ROUTING_ALLOW_FALLBACKS: String(
            routing.allowFallbacks,
          ),
        }),
    ...(routing.requireParameters === null
      ? {}
      : {
          ORGANUM_CODE_ROUTING_REQUIRE_PARAMETERS: String(
            routing.requireParameters,
          ),
        }),
    ...(routing.dataCollection === null
      ? {}
      : { ORGANUM_CODE_ROUTING_DATA_COLLECTION: routing.dataCollection }),
    ...(routing.zeroDataRetention === null
      ? {}
      : { ORGANUM_CODE_ROUTING_ZDR: String(routing.zeroDataRetention) }),
    ...(routing.maxPrice?.prompt === undefined
      ? {}
      : {
          ORGANUM_CODE_ROUTING_MAX_PROMPT_PRICE: String(
            routing.maxPrice.prompt,
          ),
        }),
    ...(routing.maxPrice?.completion === undefined
      ? {}
      : {
          ORGANUM_CODE_ROUTING_MAX_COMPLETION_PRICE: String(
            routing.maxPrice.completion,
          ),
        }),
    ...(routing.maxPrice?.request === undefined
      ? {}
      : {
          ORGANUM_CODE_ROUTING_MAX_REQUEST_PRICE: String(
            routing.maxPrice.request,
          ),
        }),
    ...(routing.maxPrice?.image === undefined
      ? {}
      : {
          ORGANUM_CODE_ROUTING_MAX_IMAGE_PRICE: String(
            routing.maxPrice.image,
          ),
        }),
    ...(routing.referer === null
      ? {}
      : { ORGANUM_CODE_OPENROUTER_REFERER: routing.referer }),
    ...(routing.title === null
      ? {}
      : { ORGANUM_CODE_OPENROUTER_TITLE: routing.title }),
  };
}

export function configToEnvironment(
  config: UserConfig,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const defaults: NodeJS.ProcessEnv = {
    ORGANUM_CODE_PROVIDER_ID: config.provider.id,
    ORGANUM_CODE_PROVIDER_NAME: config.provider.name,
    ORGANUM_CODE_BASE_URL: config.provider.baseURL,
    ORGANUM_CODE_MODEL: config.provider.modelID,
    ORGANUM_CODE_MODEL_NAME: config.provider.modelName,
    ORGANUM_CODE_PROTOCOL: config.provider.protocol,
    ORGANUM_CODE_API_KEY_ENV: config.provider.apiKeyEnv,
    ORGANUM_CODE_BACKEND: config.backend.default,
    ...capabilityEnvironment(config.provider.capabilities),
    ...routingEnvironment(config.provider.routing),
    ...secretEnvironment(config.provider.secret),
  };
  const result = { ...defaults };
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) result[name] = value;
  }
  if (env.ORGANUM_CODE_SECRET_SOURCE === undefined) {
    const effectiveKeyName = result.ORGANUM_CODE_API_KEY_ENV;
    if (effectiveKeyName && result[effectiveKeyName]?.trim()) {
      result.ORGANUM_CODE_SECRET_SOURCE = "environment";
    } else if (env.ORGANUM_CODE_SECRET_FILE?.trim()) {
      result.ORGANUM_CODE_SECRET_SOURCE = "dotenv";
    }
  }
  return result;
}
