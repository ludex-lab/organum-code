import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  ConfigurationError,
  type ProviderProfile,
} from "./provider-profile.js";

export type ProviderSecretSourceKind =
  | "environment"
  | "dotenv"
  | "keychain";

export interface ProviderSecret {
  /** Keep this object supervisor-only. Never serialize it into reports/config. */
  value: string;
  source: {
    kind: ProviderSecretSourceKind;
    label: string;
  };
}

export interface ProviderSecretDependencies {
  platform?: NodeJS.Platform;
  keychainRead?: (service: string, account: string) => Promise<string>;
}

const MAX_SECRET_FILE_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 16 * 1024;

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateSecret(value: string, context: string): string {
  const secret = value.trim();
  if (secret.length === 0) {
    throw new ConfigurationError(`${context} returned an empty secret`);
  }
  if (secret.includes("\0")) {
    throw new ConfigurationError(`${context} returned a secret containing NUL`);
  }
  if (Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES) {
    throw new ConfigurationError(`${context} returned an oversized secret`);
  }
  return secret;
}

function unquoteDotenvValue(raw: string, name: string): string {
  const value = raw.trim();
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw new ConfigurationError(`Malformed single-quoted ${name} in secret file`);
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      throw new ConfigurationError(`Malformed double-quoted ${name} in secret file`);
    }
    return value
      .slice(1, -1)
      .replace(/\\([nrt"\\])/g, (_match, escaped: string) => {
        if (escaped === "n") return "\n";
        if (escaped === "r") return "\r";
        if (escaped === "t") return "\t";
        return escaped;
      });
  }
  const comment = /\s+#/.exec(value);
  return (comment === null ? value : value.slice(0, comment.index)).trim();
}

export function parseDotenvSecret(
  content: string,
  name: string,
): string {
  let found: string | undefined;
  for (const [index, original] of content.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=([\s\S]*)$/.exec(
      line,
    );
    if (assignment === null) continue;
    if (assignment[1] !== name) continue;
    if (found !== undefined) {
      throw new ConfigurationError(
        `Duplicate ${name} in secret file at line ${index + 1}`,
      );
    }
    found = unquoteDotenvValue(assignment[2], name);
  }
  if (found === undefined) {
    throw new ConfigurationError(`${name} is missing from secret file`);
  }
  return validateSecret(found, `Secret file ${name}`);
}

async function readDotenvSecret(
  path: string,
  name: string,
  workspace: string | undefined,
  platform: NodeJS.Platform,
): Promise<ProviderSecret> {
  if (!isAbsolute(path)) {
    throw new ConfigurationError("ORGANUM_CODE_SECRET_FILE must be absolute");
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ConfigurationError(
      "ORGANUM_CODE_SECRET_FILE must be a regular non-symlink file",
    );
  }
  if (metadata.size > MAX_SECRET_FILE_BYTES) {
    throw new ConfigurationError("ORGANUM_CODE_SECRET_FILE is too large");
  }
  if (platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new ConfigurationError(
      "ORGANUM_CODE_SECRET_FILE must not be accessible by group or other users",
    );
  }
  const canonical = await realpath(path);
  if (workspace !== undefined) {
    const canonicalWorkspace = await realpath(workspace).catch(() => resolve(workspace));
    if (inside(canonicalWorkspace, canonical)) {
      throw new ConfigurationError(
        "ORGANUM_CODE_SECRET_FILE must be outside the backend-visible workspace",
      );
    }
  }
  const content = await readFile(canonical, "utf8");
  return {
    value: parseDotenvSecret(content, name),
    source: { kind: "dotenv", label: canonical },
  };
}

function defaultKeychainRead(service: string, account: string): Promise<string> {
  return new Promise((resolveRead, rejectRead) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: MAX_SECRET_BYTES,
        env: { PATH: "/usr/bin:/bin" },
      },
      (error, stdout) => {
        if (error !== null) {
          rejectRead(
            new ConfigurationError(
              `Unable to read provider key from macOS Keychain service ${JSON.stringify(service)}`,
            ),
          );
          return;
        }
        resolveRead(stdout);
      },
    );
  });
}

async function readKeychainSecret(
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv,
  reader: (service: string, account: string) => Promise<string>,
): Promise<ProviderSecret> {
  const service =
    env.ORGANUM_CODE_KEYCHAIN_SERVICE?.trim() ||
    `organum-code.${profile.providerID}`;
  const account = env.ORGANUM_CODE_KEYCHAIN_ACCOUNT?.trim() || "default";
  if (service.includes("\0") || account.includes("\0")) {
    throw new ConfigurationError("Keychain service/account must not contain NUL");
  }
  return {
    value: validateSecret(await reader(service, account), "macOS Keychain"),
    source: { kind: "keychain", label: `${service}/${account}` },
  };
}

export async function loadProviderSecret(
  profile: ProviderProfile,
  env: NodeJS.ProcessEnv,
  options: {
    workspace?: string;
    dependencies?: ProviderSecretDependencies;
  } = {},
): Promise<ProviderSecret> {
  const source = env.ORGANUM_CODE_SECRET_SOURCE?.trim() || "auto";
  if (!["auto", "environment", "dotenv", "keychain"].includes(source)) {
    throw new ConfigurationError(
      "ORGANUM_CODE_SECRET_SOURCE must be auto, environment, dotenv, or keychain",
    );
  }
  const platform = options.dependencies?.platform ?? process.platform;
  const fromEnvironment = env[profile.apiKeyEnv]?.trim();
  if (source === "environment" || (source === "auto" && fromEnvironment)) {
    if (!fromEnvironment) {
      throw new ConfigurationError(`${profile.apiKeyEnv} is required`);
    }
    return {
      value: validateSecret(fromEnvironment, profile.apiKeyEnv),
      source: { kind: "environment", label: profile.apiKeyEnv },
    };
  }

  const secretFile = env.ORGANUM_CODE_SECRET_FILE?.trim();
  if (source === "dotenv" || (source === "auto" && secretFile)) {
    if (!secretFile) {
      throw new ConfigurationError(
        "ORGANUM_CODE_SECRET_FILE is required for dotenv secret source",
      );
    }
    return await readDotenvSecret(
      secretFile,
      profile.apiKeyEnv,
      options.workspace,
      platform,
    );
  }

  if (source === "keychain" || (source === "auto" && platform === "darwin")) {
    if (platform !== "darwin") {
      throw new ConfigurationError(
        "macOS Keychain secret source is available only on Darwin",
      );
    }
    return await readKeychainSecret(
      profile,
      env,
      options.dependencies?.keychainRead ?? defaultKeychainRead,
    );
  }

  throw new ConfigurationError(
    `No provider key source is configured for ${profile.apiKeyEnv}`,
  );
}
