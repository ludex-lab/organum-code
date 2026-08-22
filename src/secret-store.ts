import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { ConfigurationError } from "./provider-profile.js";

const MAX_SECRET_BYTES = 16 * 1024;

function validLabel(value: string, context: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\0")) {
    throw new ConfigurationError(`${context} must be non-empty and contain no NUL`);
  }
  return normalized;
}

function validSecret(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ConfigurationError("API key must not be empty");
  if (normalized.includes("\0")) {
    throw new ConfigurationError("API key must not contain NUL");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_SECRET_BYTES) {
    throw new ConfigurationError("API key is too large");
  }
  return normalized;
}

export function buildKeychainWriteArgs(
  service: string,
  account: string,
): string[] {
  return [
    "add-generic-password",
    "-U",
    "-s",
    validLabel(service, "Keychain service"),
    "-a",
    validLabel(account, "Keychain account"),
    // `security` prompts with echo disabled when -w is the last option and no
    // value follows it. The credential therefore never appears in argv.
    "-w",
  ];
}

export type KeychainWriteRunner = (
  command: string,
  args: readonly string[],
) => Promise<number>;

function defaultKeychainWriteRunner(
  command: string,
  args: readonly string[],
): Promise<number> {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { PATH: "/usr/bin:/bin" },
    });
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
}

export async function storeKeychainSecret(
  service: string,
  account: string,
  options: {
    platform?: NodeJS.Platform;
    runner?: KeychainWriteRunner;
  } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin") {
    throw new ConfigurationError("macOS Keychain is available only on Darwin");
  }
  const args = buildKeychainWriteArgs(service, account);
  const code = await (options.runner ?? defaultKeychainWriteRunner)(
    "/usr/bin/security",
    args,
  );
  if (code !== 0) {
    throw new ConfigurationError(
      `Unable to save provider key in macOS Keychain service ${JSON.stringify(service)}`,
    );
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function quoteDotenv(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}

export async function savePrivateDotenvSecret(
  path: string,
  environmentName: string,
  value: string,
  options: {
    workspace?: string;
    platform?: NodeJS.Platform;
  } = {},
): Promise<void> {
  if (!isAbsolute(path)) {
    throw new ConfigurationError("Private dotenv path must be absolute");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(environmentName)) {
    throw new ConfigurationError("API key environment name is invalid");
  }
  const secret = validSecret(value);
  const directory = dirname(path);
  const priorDirectory = await lstat(directory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (priorDirectory === null && (options.platform ?? process.platform) !== "win32") {
    await chmod(directory, 0o700);
  }
  const canonicalDirectory = await realpath(directory);
  const canonicalPath = join(canonicalDirectory, basename(path));
  if (options.workspace !== undefined) {
    const canonicalWorkspace = await realpath(options.workspace).catch(() =>
      resolve(options.workspace!),
    );
    if (inside(canonicalWorkspace, canonicalPath)) {
      throw new ConfigurationError(
        "Private dotenv must be outside the backend-visible workspace",
      );
    }
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
      "Private dotenv must be a regular non-symlink file",
    );
  }

  const temporary = join(canonicalDirectory, `.organum-code-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(
      `${environmentName}=${quoteDotenv(secret)}\n`,
      "utf8",
    );
    await handle.sync();
    await handle.close();
    await rename(temporary, canonicalPath);
    if ((options.platform ?? process.platform) !== "win32") {
      await chmod(canonicalPath, 0o600);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}
