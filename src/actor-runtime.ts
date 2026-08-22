import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ConfigurationError } from "./provider-profile.js";
import type { ConfiguredBackend } from "./user-config.js";

export const ACTOR_RUNTIME_BINDING_SCHEMA =
  "organum-code/actor-runtime-binding/v1" as const;

const WORKSPACE_DOMAIN = "organum-code/actor-workspace/v1";
const MAX_BINDING_BYTES = 16 * 1024;

export interface ActorRuntimeBinding {
  schema: typeof ACTOR_RUNTIME_BINDING_SCHEMA;
  actor: string;
  profile: string;
  backend: ConfiguredBackend;
  workspaceFingerprint: string;
}

export interface AllocatedActorRuntime {
  actor: string;
  profile: string;
  backend: ConfiguredBackend;
  stateDirectory: string;
  runtimeDirectory: string;
  bindingPath: string;
  workspaceFingerprint: string;
}

export interface AllocateActorRuntimeOptions {
  actor: string;
  profile?: string | null;
  backend: ConfiguredBackend;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fallbackHome?: string;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function existingDirectory(
  path: string,
  context: string,
): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ConfigurationError(`${context} must be an absolute path`);
  }
  const canonical = await realpath(path).catch((error: unknown) => {
    throw new ConfigurationError(
      `${context} is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory()) {
    throw new ConfigurationError(`${context} must be a directory`);
  }
  return canonical;
}

async function ensurePrivateDirectory(
  path: string,
  context: string,
): Promise<string> {
  await mkdir(path, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ConfigurationError(
      `${context} must be a real non-symlink directory`,
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new ConfigurationError(
      `${context} must not be accessible by group or other users`,
    );
  }
  return await realpath(path);
}

export function normalizeActorName(value: string): string {
  const actor = value.trim().toLowerCase();
  if (
    !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(actor) ||
    actor.endsWith(".")
  ) {
    throw new ConfigurationError(
      "Actor name must be 1-40 ASCII letters, numbers, dots, underscores, or hyphens; it must start with a letter/number and not end with a dot",
    );
  }
  return actor;
}

export function resolveActorStateDirectory(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  fallbackHome: string = homedir(),
): string {
  const explicit = env.ORGANUM_CODE_STATE_DIR?.trim();
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new ConfigurationError("ORGANUM_CODE_STATE_DIR must be absolute");
    }
    return resolve(explicit);
  }
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg) {
    if (!isAbsolute(xdg)) {
      throw new ConfigurationError("XDG_STATE_HOME must be absolute");
    }
    return join(resolve(xdg), "organum-code");
  }
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData && isAbsolute(localAppData)) {
      return join(resolve(localAppData), "organum-code", "state");
    }
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || fallbackHome;
  if (!home || !isAbsolute(home)) {
    throw new ConfigurationError("Unable to resolve the actor state directory");
  }
  return join(resolve(home), ".local", "state", "organum-code");
}

export function actorWorkspaceFingerprint(canonicalWorkspace: string): string {
  return createHash("sha256")
    .update(WORKSPACE_DOMAIN)
    .update("\0")
    .update(canonicalWorkspace)
    .digest("hex")
    .slice(0, 24);
}

function exactBinding(
  value: unknown,
  expected: ActorRuntimeBinding,
): value is ActorRuntimeBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.schema === expected.schema &&
    candidate.actor === expected.actor &&
    candidate.profile === expected.profile &&
    candidate.backend === expected.backend &&
    candidate.workspaceFingerprint === expected.workspaceFingerprint &&
    Object.keys(candidate).length === 5
  );
}

async function installOrVerifyBinding(
  path: string,
  expected: ActorRuntimeBinding,
): Promise<void> {
  const serialized = `${JSON.stringify(expected, null, 2)}\n`;
  const handle = await open(path, "wx", 0o600).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return null;
      throw error;
    },
  );
  if (handle !== null) {
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }

  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ConfigurationError(
      "Actor runtime binding must be a regular non-symlink file",
    );
  }
  if (metadata.size > MAX_BINDING_BYTES) {
    throw new ConfigurationError("Actor runtime binding is too large");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new ConfigurationError(
      "Actor runtime binding must not be accessible by group or other users",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ConfigurationError("Actor runtime binding is not valid JSON");
  }
  if (!exactBinding(decoded, expected)) {
    throw new ConfigurationError(
      "Actor runtime binding does not match the requested actor scope",
    );
  }
}

export async function allocateActorRuntime(
  options: AllocateActorRuntimeOptions,
): Promise<AllocatedActorRuntime> {
  const env = options.env ?? process.env;
  const actor = normalizeActorName(options.actor);
  const profile =
    options.profile === null || options.profile === undefined
      ? "default"
      : normalizeActorName(options.profile);
  const workspace = await existingDirectory(
    options.workspace,
    "Actor workspace",
  );
  const requestedStateDirectory = resolveActorStateDirectory(
    env,
    options.platform,
    options.fallbackHome,
  );
  if (
    inside(workspace, requestedStateDirectory) ||
    inside(requestedStateDirectory, workspace)
  ) {
    throw new ConfigurationError(
      "Actor state directory must be disjoint from the workspace",
    );
  }

  await mkdir(requestedStateDirectory, { recursive: true, mode: 0o700 });
  const stateDirectory = await ensurePrivateDirectory(
    requestedStateDirectory,
    "Actor state directory",
  );
  if (inside(workspace, stateDirectory) || inside(stateDirectory, workspace)) {
    throw new ConfigurationError(
      "Actor state directory must be disjoint from the workspace",
    );
  }

  const workspaceFingerprint = actorWorkspaceFingerprint(workspace);
  let directory = stateDirectory;
  for (const segment of [
    "actors",
    workspaceFingerprint,
    profile,
    options.backend,
    actor,
  ]) {
    directory = await ensurePrivateDirectory(
      join(directory, segment),
      "Actor runtime scope",
    );
  }
  const bindingPath = join(directory, "binding.json");
  await installOrVerifyBinding(bindingPath, {
    schema: ACTOR_RUNTIME_BINDING_SCHEMA,
    actor,
    profile,
    backend: options.backend,
    workspaceFingerprint,
  });
  const runtimeDirectory = await ensurePrivateDirectory(
    join(directory, "runtime"),
    "Actor runtime directory",
  );
  return {
    actor,
    profile,
    backend: options.backend,
    stateDirectory,
    runtimeDirectory,
    bindingPath,
    workspaceFingerprint,
  };
}
