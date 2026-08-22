import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { parse, quote, type ParseEntry } from "shell-quote";

const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MACOS_CREDENTIAL_DENIES = [
  'com.apple.SecurityServer',
  'com.apple.securityd.xpc',
] as const;

const SYSTEM_READ_ROOTS = [
  "/System",
  "/bin",
  "/dev",
  "/Library/Apple",
  "/Library/Developer",
  "/opt/homebrew",
  // Current macOS resolves `/bin/sh` through the read-only shell selector.
  "/private/var/select",
  // Keep the lexical macOS symlink spelling as well as its canonical
  // `/private/etc` target. Some native CLIs probe fixed `/etc/...` paths and
  // sandbox-exec evaluates the directory lookup before resolving the symlink.
  "/etc",
  "/private/etc",
  "/sbin",
  "/usr",
] as const;

export class ContainmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainmentUnavailableError";
  }
}

export interface ContainmentPolicy {
  workspace: string;
  workspaceWritable?: boolean;
  brokerOrigin: string;
  readablePaths?: readonly string[];
  writablePaths?: readonly string[];
  immutablePaths?: readonly string[];
  temporaryDirectory: string;
  allowPty?: boolean;
}

export interface ContainedSpawn {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface PreparedBackendContainment {
  binary: string;
  cwd: string;
  gate: MacOSContainmentGate;
  spawn: ContainedSpawn;
}

export interface BackendContainmentRequest {
  binary: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  workspace: string;
  workspaceWritable?: boolean;
  runtimeDirectory: string;
  brokerOrigin: string;
  readablePaths?: readonly string[];
  immutablePaths?: readonly string[];
  allowPty?: boolean;
}

interface SandboxDependencies {
  initialize(
    config: SandboxRuntimeConfig,
    ask?: (request: { host: string; port: number | undefined }) => Promise<boolean>,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  wrapWithSandbox(
    command: string,
    shell?: string,
  ): Promise<string>;
  reset(): Promise<void>;
  isSupportedPlatform(): boolean;
  checkDependencies(): { errors: string[]; warnings: string[] };
}

export interface ContainmentDependencies {
  platform?: NodeJS.Platform;
  sandbox?: SandboxDependencies;
}

interface BrokerEndpoint {
  host: string;
  port: number;
}

function absolutePath(value: string, context: string): string {
  if (!isAbsolute(value)) {
    throw new TypeError(`${context} must be absolute`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${context} must not contain NUL`);
  }
  const candidate = resolve(value);
  try {
    return realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

export function canonicalExistingPath(value: string, context: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new ContainmentUnavailableError(`${context} must be an absolute path`);
  }
  try {
    return realpathSync.native(value);
  } catch (error) {
    throw new ContainmentUnavailableError(
      `${context} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resolveExecutablePath(
  value: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  const binary = value.trim();
  if (binary.length === 0 || binary.includes("\0")) {
    throw new ContainmentUnavailableError(
      "Backend executable must be nonempty and contain no NUL",
    );
  }
  const candidates = isAbsolute(binary) || binary.includes("/") || binary.includes("\\")
    ? [isAbsolute(binary) ? binary : resolve(cwd, binary)]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter((entry) => entry.length > 0)
        .map((entry) => join(isAbsolute(entry) ? entry : resolve(cwd, entry), binary));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync.native(candidate);
    } catch {
      // Continue through the explicit PATH candidates.
    }
  }
  throw new ContainmentUnavailableError(
    `Backend executable ${JSON.stringify(binary)} is not an executable file in the selected PATH`,
  );
}

function absolutePathVariants(value: string, context: string): string[] {
  if (!isAbsolute(value)) {
    throw new TypeError(`${context} must be absolute`);
  }
  if (value.includes("\0")) {
    throw new TypeError(`${context} must not contain NUL`);
  }
  const lexical = resolve(value);
  const canonical = absolutePath(value, context);
  return lexical === canonical ? [lexical] : [lexical, canonical];
}

function uniquePaths(values: readonly string[], context: string): string[] {
  return [
    ...new Set(values.flatMap((value) => absolutePathVariants(value, context))),
  ];
}

function brokerEndpoint(origin: string): BrokerEndpoint {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" &&
      url.hostname !== "localhost" &&
      url.hostname !== "[::1]" &&
      url.hostname !== "::1") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    url.port.length === 0
  ) {
    throw new TypeError(
      "Containment broker origin must be an uncredentialed loopback HTTP origin with an explicit port",
    );
  }
  const port = Number.parseInt(url.port, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("Containment broker port is invalid");
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

function hostMatches(actual: string, expected: string): boolean {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/^\[|\]$/g, "");
  return normalize(actual) === normalize(expected);
}

function mandatoryWriteDenies(workspace: string): string[] {
  const home = homedir();
  return [
    join(workspace, ".git"),
    join(workspace, ".env"),
    join(home, ".npm", "_logs"),
    join(home, ".claude", "debug"),
    "/tmp/claude",
    "/private/tmp/claude",
  ];
}

export function buildMacOSContainmentConfig(
  policy: ContainmentPolicy,
): SandboxRuntimeConfig {
  const workspace = absolutePath(policy.workspace, "Containment workspace");
  const temporaryDirectory = absolutePath(
    policy.temporaryDirectory,
    "Containment temporary directory",
  );
  const readablePaths = uniquePaths(
    [
      ...SYSTEM_READ_ROOTS,
      policy.workspace,
      workspace,
      policy.temporaryDirectory,
      temporaryDirectory,
      ...(policy.readablePaths ?? []),
    ],
    "Containment read path",
  );
  const writablePaths = uniquePaths(
    [
      ...(policy.workspaceWritable === false
        ? []
        : [policy.workspace, workspace]),
      policy.temporaryDirectory,
      temporaryDirectory,
      ...(policy.writablePaths ?? []),
    ],
    "Containment write path",
  );
  const denyWrite = uniquePaths(
    [
      ...mandatoryWriteDenies(workspace),
      ...mandatoryWriteDenies(resolve(policy.workspace)),
      ...(policy.immutablePaths ?? []),
    ],
    "Containment immutable path",
  );

  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    },
    filesystem: {
      denyRead: ["/"],
      allowRead: readablePaths,
      allowWrite: writablePaths,
      denyWrite,
      allowGitConfig: false,
    },
    allowPty: policy.allowPty ?? true,
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false,
  };
}

function onlyStrings(entries: ParseEntry[]): string[] {
  return entries.map((entry) => {
    if (typeof entry === "string") return entry;
    if (
      "op" in entry &&
      entry.op === "glob" &&
      /^(?:NO_PROXY|no_proxy)=/.test(entry.pattern)
    ) {
      // Sandbox Runtime deliberately emits wildcard NO_PROXY assignments as
      // shell assignment words. We execute the parsed argv directly, so the
      // pattern is data rather than a shell glob.
      return entry.pattern;
    }
    throw new ContainmentUnavailableError(
      `Sandbox Runtime produced an unsafe shell control token: ${JSON.stringify(entry)}`,
    );
  });
}

export function hardenMacOSWrappedCommand(
  wrapped: string,
  directBrokerOrigin?: string,
  directCommand?: readonly string[],
): {
  executable: string;
  args: string[];
  profile: string;
} {
  const tokens = onlyStrings(parse(wrapped));
  const executableIndex = tokens.indexOf(MACOS_SANDBOX_EXEC);
  if (
    executableIndex < 1 ||
    tokens[executableIndex + 1] !== "-p" ||
    tokens[executableIndex + 2] === undefined
  ) {
    throw new ContainmentUnavailableError(
      "Sandbox Runtime did not produce the expected macOS Seatbelt command",
    );
  }
  const profileIndex = executableIndex + 2;
  const lines = tokens[profileIndex].split("\n");
  const readStart = lines.indexOf("; File read");
  const writeStart = lines.indexOf("; File write");
  if (readStart < 0 || writeStart <= readStart) {
    throw new ContainmentUnavailableError(
      "Sandbox Runtime Seatbelt read section shape changed",
    );
  }
  let removedGlobalRead = false;
  let removedRootReadDeny = false;
  const hardenedLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inReadSection = index > readStart && index < writeStart;
    if (inReadSection && line === "(allow file-read*)") {
      if (removedGlobalRead) {
        throw new ContainmentUnavailableError(
          "Sandbox Runtime emitted multiple global file-read grants",
        );
      }
      removedGlobalRead = true;
      continue;
    }
    if (
      inReadSection &&
      line === "(deny file-read*" &&
      lines[index + 1]?.trim() === '(subpath "/")' &&
      /^\(with message ".*"\)\)$/.test(lines[index + 2]?.trim() ?? "")
    ) {
      if (removedRootReadDeny) {
        throw new ContainmentUnavailableError(
          "Sandbox Runtime emitted multiple root file-read denies",
        );
      }
      removedRootReadDeny = true;
      index += 2;
      continue;
    }
    hardenedLines.push(line);
  }
  if (!removedGlobalRead || !removedRootReadDeny) {
    throw new ContainmentUnavailableError(
      "Sandbox Runtime Seatbelt read policy cannot be converted to allow-only mode",
    );
  }
  const credentialDenies = MACOS_CREDENTIAL_DENIES.map(
    (service) => `(deny mach-lookup (global-name ${JSON.stringify(service)}))`,
  ).join("\n");
  const directBrokerAllow =
    directBrokerOrigin === undefined
      ? ""
      : (() => {
          const endpoint = brokerEndpoint(directBrokerOrigin);
          return `\n\n; Organum Code exact direct broker transport\n(allow network-outbound (remote ip ${JSON.stringify(`localhost:${endpoint.port}`)}))`;
        })();
  tokens[profileIndex] = `${hardenedLines.join("\n")}\n\n; Organum Code credential boundary\n${credentialDenies}${directBrokerAllow}`;

  if (directCommand !== undefined) {
    if (
      directCommand.length === 0 ||
      directCommand.some((argument) => argument.includes("\0"))
    ) {
      throw new ContainmentUnavailableError(
        "Direct contained command must be nonempty and contain no NUL",
      );
    }
    tokens.splice(profileIndex + 1, tokens.length, ...directCommand);
  }

  return {
    executable: tokens[0],
    args: tokens.slice(1),
    profile: tokens[profileIndex],
  };
}

/**
 * One gate belongs to one Organum Code supervisor process. Separate terminal
 * actors use separate supervisor processes, broker ports, and gate instances.
 */
export class MacOSContainmentGate {
  readonly config: SandboxRuntimeConfig;
  readonly #sandbox: SandboxDependencies;
  readonly #broker: BrokerEndpoint;
  readonly #brokerOrigin: string;
  readonly #temporaryDirectory: string;
  #closed = false;

  private constructor(
    policy: ContainmentPolicy,
    sandbox: SandboxDependencies,
  ) {
    this.config = buildMacOSContainmentConfig(policy);
    this.#sandbox = sandbox;
    this.#broker = brokerEndpoint(policy.brokerOrigin);
    this.#brokerOrigin = new URL(policy.brokerOrigin).origin;
    this.#temporaryDirectory = absolutePath(
      policy.temporaryDirectory,
      "Containment temporary directory",
    );
  }

  static async create(
    policy: ContainmentPolicy,
    dependencies: ContainmentDependencies = {},
  ): Promise<MacOSContainmentGate> {
    const platform = dependencies.platform ?? process.platform;
    const sandbox = dependencies.sandbox ?? SandboxManager;
    if (platform !== "darwin" || !sandbox.isSupportedPlatform()) {
      throw new ContainmentUnavailableError(
        "Required macOS containment is unavailable on this platform",
      );
    }
    const status = sandbox.checkDependencies();
    if (status.errors.length > 0 || status.warnings.length > 0) {
      throw new ContainmentUnavailableError(
        `Required containment dependencies are not healthy: ${[
          ...status.errors,
          ...status.warnings,
        ].join(", ")}`,
      );
    }
    const gate = new MacOSContainmentGate(policy, sandbox);
    try {
      await sandbox.initialize(
        gate.config,
        async ({ host, port }) =>
          port === gate.#broker.port && hostMatches(host, gate.#broker.host),
        false,
      );
    } catch (error) {
      await sandbox.reset().catch(() => undefined);
      throw new ContainmentUnavailableError(
        `Failed to initialize mandatory containment: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return gate;
  }

  async wrap(
    executable: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<ContainedSpawn> {
    if (this.#closed) {
      throw new ContainmentUnavailableError("Containment gate is already closed");
    }
    const command = quote([
      "env",
      "NO_PROXY=",
      "no_proxy=",
      `TMPDIR=${this.#temporaryDirectory}`,
      `TMP=${this.#temporaryDirectory}`,
      `TEMP=${this.#temporaryDirectory}`,
      executable,
      ...args,
    ]);
    const directCommand = [
      "env",
      "NO_PROXY=",
      "no_proxy=",
      `TMPDIR=${this.#temporaryDirectory}`,
      `TMP=${this.#temporaryDirectory}`,
      `TEMP=${this.#temporaryDirectory}`,
      executable,
      ...args,
    ];
    let wrapped: string;
    try {
      wrapped = await this.#sandbox.wrapWithSandbox(command, "/bin/bash");
    } catch (error) {
      throw new ContainmentUnavailableError(
        `Failed to apply mandatory containment: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const hardened = hardenMacOSWrappedCommand(
      wrapped,
      this.#brokerOrigin,
      directCommand,
    );
    return {
      executable: hardened.executable,
      args: hardened.args,
      env: {
        ...env,
        TMPDIR: this.#temporaryDirectory,
        TMP: this.#temporaryDirectory,
        TEMP: this.#temporaryDirectory,
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sandbox.reset();
  }
}

export async function prepareBackendContainment(
  request: BackendContainmentRequest,
  dependencies: ContainmentDependencies = {},
): Promise<PreparedBackendContainment> {
  const cwd = canonicalExistingPath(request.workspace, "Backend workspace");
  const runtimeDirectory = canonicalExistingPath(
    request.runtimeDirectory,
    "Backend runtime directory",
  );
  const binary = resolveExecutablePath(request.binary, request.env, cwd);
  const temporaryDirectory = join(runtimeDirectory, "tmp");
  await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
  const gate = await MacOSContainmentGate.create(
    {
      workspace: cwd,
      workspaceWritable: request.workspaceWritable,
      brokerOrigin: request.brokerOrigin,
      readablePaths: [
        runtimeDirectory,
        binary,
        ...(request.readablePaths ?? []),
      ],
      writablePaths: [runtimeDirectory],
      immutablePaths: request.immutablePaths,
      temporaryDirectory,
      allowPty: request.allowPty,
    },
    dependencies,
  );
  try {
    const spawn = await gate.wrap(binary, request.args, request.env);
    return { binary, cwd, gate, spawn };
  } catch (error) {
    await gate.close().catch(() => undefined);
    throw error;
  }
}
