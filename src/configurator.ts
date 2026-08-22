import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import {
  inspectBackendCatalog,
  selectableBackends,
  type BackendCatalogEntry,
} from "./backend-catalog.js";
import {
  ConfigurationError,
  loadProviderProfile,
  type ModelCapabilityProfile,
  type OpenRouterMaxPrice,
  type ProviderRoutingProfile,
  type ProviderProtocol,
} from "./provider-profile.js";
import { loadProviderSecret } from "./provider-secret.js";
import {
  savePrivateDotenvSecret,
  storeKeychainSecret,
} from "./secret-store.js";
import {
  DEFAULT_OPENCODE_ZEN_FREE_MODEL,
  OPENCODE_ZEN_FREE_MODELS,
  openCodeZenFreeModel,
} from "./opencode-zen-models.js";
import {
  defaultSecretFilePath,
  saveUserConfig,
  USER_CONFIG_SCHEMA,
  type ConfiguredBackend,
  type UserConfig,
  type UserSecretReference,
} from "./user-config.js";

export interface ConfiguratorChoice {
  value: string;
  label: string;
}

export interface ConfiguratorIO {
  readonly interactive: boolean;
  line(message?: string): void;
  input(prompt: string, defaultValue?: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  choose(
    prompt: string,
    choices: readonly ConfiguratorChoice[],
    defaultValue?: string,
  ): Promise<string>;
}

export interface ConfiguratorDependencies {
  platform?: NodeJS.Platform;
  catalog?: readonly BackendCatalogEntry[];
  now?: () => Date;
  keychainStore?: typeof storeKeychainSecret;
  dotenvStore?: typeof savePrivateDotenvSecret;
  secretLoader?: typeof loadProviderSecret;
}

async function terminalLineInput(
  prompt: string,
  defaultValue?: string,
): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function terminalSecretInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ConfigurationError("A TTY is required for hidden API key input");
  }
  return await new Promise<string>((resolveSecret, rejectSecret) => {
    let value = "";
    const wasRaw = process.stdin.isRaw;
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };
    const finish = (): void => {
      cleanup();
      process.stdout.write("\n");
      resolveSecret(value);
    };
    const cancel = (): void => {
      cleanup();
      process.stdout.write("\n");
      rejectSecret(new ConfigurationError("Configuration cancelled"));
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          cancel();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    process.stdout.write(`${prompt}: `);
    process.stdin.on("data", onData);
    process.stdin.setRawMode(true);
    process.stdin.resume();
  });
}

export const terminalConfiguratorIO: ConfiguratorIO = {
  get interactive() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  },
  line(message = "") {
    process.stdout.write(`${message}\n`);
  },
  input: terminalLineInput,
  secret: terminalSecretInput,
  async choose(prompt, choices, defaultValue) {
    if (choices.length === 0) {
      throw new ConfigurationError(`${prompt}: no choices are available`);
    }
    this.line(prompt);
    for (const [index, choice] of choices.entries()) {
      const marker = choice.value === defaultValue ? " (기본)" : "";
      this.line(`  ${index + 1}. ${choice.label}${marker}`);
    }
    const defaultIndex = Math.max(
      0,
      choices.findIndex((choice) => choice.value === defaultValue),
    );
    while (true) {
      const answer = await this.input("번호 선택", String(defaultIndex + 1));
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && choices[index] !== undefined) {
        return choices[index].value;
      }
      this.line(`1에서 ${choices.length} 사이의 번호를 입력해 주세요.`);
    }
  },
};

function profileEnvironment(values: {
  providerID: string;
  providerName: string;
  baseURL: string;
  modelID: string;
  modelName: string;
  protocol: ProviderProtocol;
  apiKeyEnv: string;
  capabilities?: ModelCapabilityProfile;
  routing?: ProviderRoutingProfile;
}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    ORGANUM_CODE_PROVIDER_ID: values.providerID,
    ORGANUM_CODE_PROVIDER_NAME: values.providerName,
    ORGANUM_CODE_BASE_URL: values.baseURL,
    ORGANUM_CODE_MODEL: values.modelID,
    ORGANUM_CODE_MODEL_NAME: values.modelName,
    ORGANUM_CODE_PROTOCOL: values.protocol,
    ORGANUM_CODE_API_KEY_ENV: values.apiKeyEnv,
  };
  if (values.capabilities !== undefined) {
    result.ORGANUM_CODE_CAPABILITY_STREAMING = values.capabilities.streaming;
    result.ORGANUM_CODE_CAPABILITY_TOOL_CALLING =
      values.capabilities.toolCalling;
    result.ORGANUM_CODE_CAPABILITY_REASONING = values.capabilities.reasoning;
  }
  if (values.routing !== undefined) {
    result.ORGANUM_CODE_ROUTING_KIND = values.routing.kind;
    result.ORGANUM_CODE_ROUTING_FALLBACK_MODELS =
      values.routing.fallbackModels.join(",");
    result.ORGANUM_CODE_ROUTING_PROVIDER_ORDER =
      values.routing.providerOrder.join(",");
    if (values.routing.sort !== null) {
      result.ORGANUM_CODE_ROUTING_SORT = values.routing.sort;
    }
    if (values.routing.allowFallbacks !== null) {
      result.ORGANUM_CODE_ROUTING_ALLOW_FALLBACKS =
        String(values.routing.allowFallbacks);
    }
    if (values.routing.requireParameters !== null) {
      result.ORGANUM_CODE_ROUTING_REQUIRE_PARAMETERS =
        String(values.routing.requireParameters);
    }
    if (values.routing.dataCollection !== null) {
      result.ORGANUM_CODE_ROUTING_DATA_COLLECTION =
        values.routing.dataCollection;
    }
    if (values.routing.zeroDataRetention !== null) {
      result.ORGANUM_CODE_ROUTING_ZDR =
        String(values.routing.zeroDataRetention);
    }
    if (values.routing.maxPrice?.prompt !== undefined) {
      result.ORGANUM_CODE_ROUTING_MAX_PROMPT_PRICE =
        String(values.routing.maxPrice.prompt);
    }
    if (values.routing.maxPrice?.completion !== undefined) {
      result.ORGANUM_CODE_ROUTING_MAX_COMPLETION_PRICE =
        String(values.routing.maxPrice.completion);
    }
    if (values.routing.maxPrice?.request !== undefined) {
      result.ORGANUM_CODE_ROUTING_MAX_REQUEST_PRICE =
        String(values.routing.maxPrice.request);
    }
    if (values.routing.maxPrice?.image !== undefined) {
      result.ORGANUM_CODE_ROUTING_MAX_IMAGE_PRICE =
        String(values.routing.maxPrice.image);
    }
    if (values.routing.referer !== null) {
      result.ORGANUM_CODE_OPENROUTER_REFERER = values.routing.referer;
    }
    if (values.routing.title !== null) {
      result.ORGANUM_CODE_OPENROUTER_TITLE = values.routing.title;
    }
  }
  return result;
}

function commaSeparated(value: string): readonly string[] {
  return value.trim() === ""
    ? []
    : value.split(",").map((entry) => entry.trim());
}

function optionalPrice(value: string): number | undefined {
  return value.trim() === "" ? undefined : Number(value);
}

async function pathExists(path: string): Promise<boolean> {
  return (await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  })) !== null;
}

function printBackendCatalog(
  io: ConfiguratorIO,
  catalog: readonly BackendCatalogEntry[],
): void {
  io.line("감지된 코딩 TUI:");
  for (const entry of catalog) {
    if (entry.installed && entry.adapterReady) {
      io.line(`  ✓ ${entry.label}: ${entry.version} (${entry.binary})`);
      continue;
    }
    if (entry.installed) {
      io.line(
        `  ◇ ${entry.label}: ${entry.version} — 설치됨, organum-code adapter 준비 중`,
      );
      io.line(`    ${entry.installURL}`);
      continue;
    }
    const adapter = entry.adapterReady ? "" : "; adapter 준비 중";
    io.line(`  – ${entry.label}: 미설치${adapter}`);
    io.line(`    ${entry.installURL}`);
    io.line(`    ${entry.installHint}`);
  }
}

async function configureSecret(
  io: ConfiguratorIO,
  env: NodeJS.ProcessEnv,
  configPath: string,
  providerValues: Parameters<typeof profileEnvironment>[0],
  workspace: string,
  platform: NodeJS.Platform,
  dependencies: ConfiguratorDependencies,
  existingSecret?: UserSecretReference,
  profileName?: string,
): Promise<UserSecretReference> {
  const profileEnv = profileEnvironment(providerValues);
  const profile = loadProviderProfile(profileEnv, { requireApiKey: false });
  const defaultFile =
    existingSecret?.source === "dotenv"
      ? existingSecret.path
      : defaultSecretFilePath(providerValues.providerID, {
          ...env,
          ORGANUM_CODE_CONFIG_FILE: configPath,
        }, platform);
  const hasEnvironment = Boolean(env[providerValues.apiKeyEnv]?.trim());
  const hasDefaultFile = await pathExists(defaultFile);
  const choices: ConfiguratorChoice[] = [];
  if (hasEnvironment) {
    choices.push({
      value: "environment",
      label: `현재 환경변수 ${providerValues.apiKeyEnv} (감지됨)`,
    });
  }
  if (platform === "darwin") {
    choices.push({
      value: "keychain",
      label: "macOS Keychain (권장; 기존 항목 사용 또는 안전하게 입력)",
    });
  }
  choices.push({
    value: "dotenv",
    label: hasDefaultFile
      ? `private dotenv (기존 기본 파일 감지: ${defaultFile})`
      : `private dotenv (workspace 밖 ${defaultFile})`,
  });
  const defaultSource =
    existingSecret?.source === "environment" && hasEnvironment
      ? "environment"
      : existingSecret?.source === "keychain" && platform === "darwin"
        ? "keychain"
        : existingSecret?.source === "dotenv"
          ? "dotenv"
          : hasEnvironment
            ? "environment"
            : platform === "darwin"
              ? "keychain"
              : "dotenv";
  const source = await io.choose("API 키 저장소를 선택하세요.", choices, defaultSource);
  const secretLoader = dependencies.secretLoader ?? loadProviderSecret;

  if (source === "environment") return { source };
  if (source === "keychain") {
    const defaultService =
      env.ORGANUM_CODE_KEYCHAIN_SERVICE?.trim() ||
      (existingSecret?.source === "keychain"
        ? existingSecret.service
        : `organum-code.${providerValues.providerID}`);
    const defaultAccount =
      env.ORGANUM_CODE_KEYCHAIN_ACCOUNT?.trim() ||
      (existingSecret?.source === "keychain"
        ? existingSecret.account
        : profileName ?? "default");
    const service = await io.input("Keychain service", defaultService);
    const account = await io.input("Keychain account", defaultAccount);
    const keychainEnv: NodeJS.ProcessEnv = {
      ...profileEnv,
      ORGANUM_CODE_SECRET_SOURCE: "keychain",
      ORGANUM_CODE_KEYCHAIN_SERVICE: service,
      ORGANUM_CODE_KEYCHAIN_ACCOUNT: account,
    };
    try {
      await secretLoader(profile, keychainEnv, {
        workspace,
        dependencies: { platform },
      });
      io.line(`기존 Keychain 항목을 사용합니다: ${service}/${account}`);
    } catch {
      io.line("기존 Keychain 항목이 없습니다. macOS 보안 입력창에 API 키를 입력하세요.");
      await (dependencies.keychainStore ?? storeKeychainSecret)(service, account, {
        platform,
      });
      await secretLoader(profile, keychainEnv, {
        workspace,
        dependencies: { platform },
      });
    }
    return { source, service, account };
  }

  const path = await io.input("private dotenv 절대 경로", defaultFile);
  const dotenvEnv: NodeJS.ProcessEnv = {
    ...profileEnv,
    ORGANUM_CODE_SECRET_SOURCE: "dotenv",
    ORGANUM_CODE_SECRET_FILE: path,
  };
  if (await pathExists(path)) {
    await secretLoader(profile, dotenvEnv, {
      workspace,
      dependencies: { platform },
    });
    io.line(`기존 private dotenv를 사용합니다: ${path}`);
  } else {
    const value = await io.secret(`${providerValues.apiKeyEnv} 입력 (표시되지 않음)`);
    await (dependencies.dotenvStore ?? savePrivateDotenvSecret)(
      path,
      providerValues.apiKeyEnv,
      value,
      { workspace, platform },
    );
    await secretLoader(profile, dotenvEnv, {
      workspace,
      dependencies: { platform },
    });
  }
  return { source: "dotenv", path };
}

export async function runConfigurator(options: {
  io?: ConfiguratorIO;
  env?: NodeJS.ProcessEnv;
  configPath: string;
  workspace?: string;
  existing?: UserConfig | null;
  profileName?: string;
  dependencies?: ConfiguratorDependencies;
}): Promise<UserConfig> {
  const io = options.io ?? terminalConfiguratorIO;
  if (!io.interactive) {
    throw new ConfigurationError(
      "Configurator requires an interactive terminal. Run `organum-code configure` in a TTY.",
    );
  }
  const env = options.env ?? process.env;
  const workspace = options.workspace ?? process.cwd();
  const dependencies = options.dependencies ?? {};
  const platform = dependencies.platform ?? process.platform;
  const existing = options.existing ?? null;

  io.line(
    options.profileName
      ? `Organum Code 설정 — profile: ${options.profileName}`
      : "Organum Code 설정 — default profile",
  );
  io.line("API 키 값은 config.json이나 TUI 환경에 저장하지 않습니다.");
  if (existing?.provider.id === "upstage") {
    io.line(
      "기존 Upstage/Solar profile은 retired 상태입니다. 새 provider를 선택해야 하며 Solar 키 reference는 재사용하지 않습니다.",
    );
  } else if (existing?.provider.id === "gemini") {
    io.line(
      "기존 Gemini API preset은 active 운용에서 제외되었습니다. Gemini는 AGY CLI 경로를 사용하며 API 키 reference는 재사용하지 않습니다.",
    );
  }
  io.line();

  const catalog = [
    ...(dependencies.catalog ?? inspectBackendCatalog(env)),
  ];
  printBackendCatalog(io, catalog);
  const selectable = selectableBackends(catalog);
  if (selectable.length === 0) {
    throw new ConfigurationError(
      "No installed TUI with a ready organum-code adapter was found. Install one and rerun `organum-code configure`.",
    );
  }
  io.line();

  const presetDefault =
    existing?.provider.id === "groq"
      ? "groq"
      : existing?.provider.id === "opencode-zen"
        ? "opencode-zen"
        : existing?.provider.id === "openrouter"
          ? "openrouter"
          : existing?.provider.id === "upstage" ||
              existing?.provider.id === "gemini"
            ? "opencode-zen"
            : "custom";
  const preset = await io.choose(
    "모델 provider를 선택하세요.",
    [
      {
        value: "opencode-zen",
        label: "OpenCode Zen (DeepSeek V4 Flash Free 기본)",
      },
      { value: "groq", label: "GroqCloud (free plan available)" },
      { value: "openrouter", label: "OpenRouter (multi-model router)" },
      { value: "custom", label: "Custom OpenAI-compatible provider" },
    ],
    existing ? presetDefault : "opencode-zen",
  );

  let providerID: string;
  let providerName: string;
  let baseURL: string;
  let apiKeyEnv: string;
  let protocol: ProviderProtocol;
  let capabilities: ModelCapabilityProfile | undefined =
    existing?.provider.capabilities;
  let routing: ProviderRoutingProfile | undefined = existing?.provider.routing;
  if (preset === "groq") {
    providerID = "groq";
    providerName = "GroqCloud";
    baseURL = "https://api.groq.com/openai/v1";
    apiKeyEnv = "GROQ_API_KEY";
    protocol = "chat-completions";
    capabilities = {
      streaming: "unknown",
      toolCalling: "unknown",
      reasoning: "unknown",
    };
    routing = undefined;
  } else if (preset === "opencode-zen") {
    providerID = "opencode-zen";
    providerName = "OpenCode Zen";
    baseURL = "https://opencode.ai/zen/v1";
    apiKeyEnv = "OPENCODE_ZEN_API_KEY";
    protocol = "chat-completions";
    capabilities = undefined;
    routing = undefined;
    io.line(
      "주의: Zen free catalog는 변경될 수 있고 입력 데이터가 모델 개선에 사용될 수 있습니다. 기밀 저장소에는 사용하지 마세요.",
    );
  } else if (preset === "openrouter") {
    providerID = "openrouter";
    providerName = "OpenRouter";
    baseURL = "https://openrouter.ai/api/v1";
    apiKeyEnv = "OPENROUTER_API_KEY";
    protocol = (await io.choose(
      "OpenRouter protocol을 선택하세요.",
      [
        {
          value: "chat-completions",
          label: "Chat Completions (안정적; Codex는 broker가 Responses로 변환)",
        },
        { value: "responses", label: "Responses (beta, stateless)" },
      ],
      existing?.provider.protocol ?? "chat-completions",
    )) as ProviderProtocol;
  } else {
    providerID = await io.input("provider ID", existing?.provider.id ?? "custom");
    providerName = await io.input(
      "provider 표시 이름",
      existing?.provider.name ?? providerID,
    );
    baseURL = await io.input(
      "OpenAI-compatible API base URL",
      existing?.provider.baseURL ?? "https://api.example.com/v1",
    );
    apiKeyEnv = await io.input(
      "API 키 환경변수 이름",
      existing?.provider.apiKeyEnv ?? "ORGANUM_CODE_API_KEY",
    );
    protocol = (await io.choose(
      "provider protocol을 선택하세요.",
      [
        { value: "chat-completions", label: "Chat Completions" },
        { value: "responses", label: "Responses" },
      ],
      existing?.provider.protocol ?? "chat-completions",
    )) as ProviderProtocol;
    if (existing?.provider.id !== providerID) {
      capabilities = undefined;
      routing = undefined;
    }
  }
  const presetModel = preset === "groq" ? "qwen/qwen3.6-27b" : undefined;
  let modelID: string;
  if (preset === "opencode-zen") {
    const existingZenModel = existing?.provider.id === "opencode-zen"
      ? existing.provider.modelID
      : undefined;
    const existingKnown = existingZenModel === undefined
      ? undefined
      : openCodeZenFreeModel(existingZenModel);
    const selection = await io.choose(
      "OpenCode Zen free model을 선택하세요.",
      [
        ...OPENCODE_ZEN_FREE_MODELS.map((entry) => ({
          value: entry.modelID,
          label: entry.label,
        })),
        { value: "custom", label: "Other exact Zen model ID" },
      ],
      existingKnown?.modelID ??
        (existingZenModel === undefined
          ? DEFAULT_OPENCODE_ZEN_FREE_MODEL
          : "custom"),
    );
    modelID = selection === "custom"
      ? await io.input("정확한 model ID", existingZenModel)
      : selection;
    const catalogModel = openCodeZenFreeModel(modelID);
    capabilities = existing?.provider.id === providerID &&
        existing.provider.modelID === modelID
      ? existing.provider.capabilities
      : catalogModel?.qualification === "coding-qualified"
        ? {
            streaming: "supported",
            toolCalling: "supported",
            reasoning: "unknown",
          }
        : {
            streaming: "unknown",
            toolCalling: "unknown",
            reasoning: "unknown",
          };
  } else {
    modelID = await io.input(
      "정확한 model ID",
      existing?.provider.id === providerID
        ? existing.provider.modelID
        : presetModel,
    );
  }
  const modelName = await io.input(
    "모델 표시 이름",
    existing?.provider.id === providerID &&
        existing.provider.modelID === modelID
      ? existing.provider.modelName
      : modelID,
  );
  if (preset === "openrouter") {
    const capabilityPreset = await io.choose(
      "선택한 model의 coding capability를 어떻게 기록할까요?",
      [
        {
          value: "unverified",
          label: "미검증 (실행 허용, capability claim 없음)",
        },
        {
          value: "coding",
          label: "streaming + tool calling 지원 확인",
        },
        {
          value: "reasoning-coding",
          label: "streaming + tools + reasoning 지원 확인",
        },
      ],
      existing?.provider.capabilities?.toolCalling === "supported"
        ? existing.provider.capabilities.reasoning === "supported"
          ? "reasoning-coding"
          : "coding"
        : "unverified",
    );
    capabilities = capabilityPreset === "unverified"
      ? { streaming: "unknown", toolCalling: "unknown", reasoning: "unknown" }
      : {
          streaming: "supported",
          toolCalling: "supported",
          reasoning:
            capabilityPreset === "reasoning-coding" ? "supported" : "unknown",
        };

    if (protocol === "chat-completions") {
      const priorRouting = existing?.provider.routing?.kind === "openrouter"
        ? existing.provider.routing
        : undefined;
      const routingPriority = await io.choose(
        "OpenRouter provider routing 우선순위를 선택하세요.",
        [
          { value: "balanced", label: "기본 price-aware uptime balancing" },
          { value: "price", label: "최저 가격 우선" },
          { value: "throughput", label: "최고 처리량 우선" },
          { value: "latency", label: "최저 지연 우선" },
        ],
        priorRouting?.sort ?? "balanced",
      );
      const fallbackModels = commaSeparated(await io.input(
        "fallback model IDs (쉼표 구분, 선택)",
        priorRouting?.fallbackModels.join(",") || undefined,
      ));
      const providerOrder = commaSeparated(await io.input(
        "provider slug 우선순위 (쉼표 구분, 선택)",
        priorRouting?.providerOrder.join(",") || undefined,
      ));
      const maxPrompt = optionalPrice(await io.input(
        "prompt 최대 가격 USD / 1M tokens (선택)",
        priorRouting?.maxPrice?.prompt === undefined
          ? undefined
          : String(priorRouting.maxPrice.prompt),
      ));
      const maxCompletion = optionalPrice(await io.input(
        "completion 최대 가격 USD / 1M tokens (선택)",
        priorRouting?.maxPrice?.completion === undefined
          ? undefined
          : String(priorRouting.maxPrice.completion),
      ));
      const maxPrice: OpenRouterMaxPrice = {
        ...(maxPrompt === undefined ? {} : { prompt: maxPrompt }),
        ...(maxCompletion === undefined ? {} : { completion: maxCompletion }),
      };
      routing = {
        kind: "openrouter",
        fallbackModels,
        providerOrder,
        sort: routingPriority === "balanced"
          ? null
          : routingPriority as "price" | "throughput" | "latency",
        allowFallbacks: true,
        requireParameters: true,
        dataCollection: "deny",
        zeroDataRetention: priorRouting?.zeroDataRetention ?? null,
        maxPrice: Object.keys(maxPrice).length === 0 ? null : maxPrice,
        referer: priorRouting?.referer ?? null,
        title: priorRouting?.title ?? null,
      };
    } else {
      const priorRouting = existing?.provider.routing?.kind === "openrouter"
        ? existing.provider.routing
        : undefined;
      routing = {
        kind: "openrouter",
        fallbackModels: [],
        providerOrder: [],
        sort: null,
        allowFallbacks: null,
        requireParameters: null,
        dataCollection: null,
        zeroDataRetention: null,
        maxPrice: null,
        referer: priorRouting?.referer ?? null,
        title: priorRouting?.title ?? null,
      };
    }
  } else if (capabilities === undefined) {
    capabilities = {
      streaming: "unknown",
      toolCalling: "unknown",
      reasoning: "unknown",
    };
  }
  const providerValues = {
    providerID,
    providerName,
    baseURL,
    modelID,
    modelName,
    protocol,
    apiKeyEnv,
    capabilities,
    routing,
  };
  loadProviderProfile(profileEnvironment(providerValues), { requireApiKey: false });
  const secret = await configureSecret(
    io,
    env,
    options.configPath,
    providerValues,
    workspace,
    platform,
    dependencies,
    existing?.provider.id === providerID
      ? existing.provider.secret
      : undefined,
    options.profileName,
  );
  io.line();

  const priorBackend = existing?.backend.default;
  const defaultBackend =
    selectable.find((entry) => entry.id === priorBackend)?.id ??
    selectable.find((entry) => entry.id === "opencode")?.id ??
    selectable[0].id;
  const backend = (await io.choose(
    "기본 코딩 TUI를 선택하세요.",
    selectable.map((entry) => ({ value: entry.id, label: entry.label })),
    defaultBackend,
  )) as ConfiguredBackend;

  const config: UserConfig = {
    schema: USER_CONFIG_SCHEMA,
    provider: {
      id: providerID,
      name: providerName,
      baseURL,
      modelID,
      modelName,
      protocol,
      apiKeyEnv,
      capabilities,
      ...(routing === undefined ? {} : { routing }),
      secret,
    },
    backend: { default: backend },
    configuredAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
  await saveUserConfig(options.configPath, config);
  io.line();
  io.line(`설정을 저장했습니다: ${options.configPath}`);
  io.line(`다음 실행부터 ${selectable.find((entry) => entry.id === backend)?.label}로 바로 들어갑니다.`);
  return config;
}
