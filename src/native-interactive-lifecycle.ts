import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { AllocatedActorRuntime } from "./actor-runtime.js";
import { ConfigurationError } from "./provider-profile.js";

export const NATIVE_INTERACTIVE_SESSION_SCHEMA =
  "organum-code/native-interactive-session/v1" as const;

const ROOT_DOMAIN = "organum-code/native-interactive-root/v1";
const SESSION_DOMAIN = "organum-code/native-interactive-session-id/v1";
const MAX_SESSION_STATE_BYTES = 16 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NativeInteractiveBackend =
  | "claude"
  | "grok"
  | "deepcode"
  | "codex"
  | "cursor";
export type NativeInteractiveLaunchMode = "new" | "resume";

export interface NativeInteractiveSessionState {
  schema: typeof NATIVE_INTERACTIVE_SESSION_SCHEMA;
  revision: number;
  actor: string;
  profile: string;
  backend: NativeInteractiveBackend;
  workspace_fingerprint: string;
  root_session_id: string;
  native_session_id: string | null;
  resumable: boolean;
}

export interface NativeInteractiveLaunchPlan {
  backend: NativeInteractiveBackend;
  rootSessionID: string;
  nativeSessionID: string | null;
  mode: NativeInteractiveLaunchMode;
  args: readonly string[];
  statePath: string;
}

export interface NativeRuntimeOwner {
  lockPath: string;
  close(): Promise<void>;
}

function interactiveBackend(
  backend: AllocatedActorRuntime["backend"],
): NativeInteractiveBackend {
  if (
    backend === "claude" ||
    backend === "grok" ||
    backend === "deepcode" ||
    backend === "codex" ||
    backend === "cursor"
  ) {
    return backend;
  }
  throw new ConfigurationError(
    "Native interactive lifecycle currently supports Claude Code, Grok Build, Deep Code, Codex, and Cursor",
  );
}

function scope(runtime: AllocatedActorRuntime): string {
  return [
    runtime.backend,
    runtime.workspaceFingerprint,
    runtime.profile,
    runtime.actor,
  ].join("\0");
}

function digest(domain: string, runtime: AllocatedActorRuntime): Buffer {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(scope(runtime))
    .digest();
}

export function nativeInteractiveRootSessionID(
  runtime: AllocatedActorRuntime,
): string {
  const backend = interactiveBackend(runtime.backend);
  return `native-${backend}-${digest(ROOT_DOMAIN, runtime).toString("hex").slice(0, 32)}`;
}

export function deterministicNativeSessionID(
  runtime: AllocatedActorRuntime,
): string | null {
  const backend = interactiveBackend(runtime.backend);
  if (backend === "deepcode" || backend === "codex" || backend === "cursor") {
    return null;
  }
  const bytes = digest(SESSION_DOMAIN, runtime).subarray(0, 16);
  // A deterministic UUIDv5-shaped identifier is accepted by both native
  // products while remaining domain-separated from the Organum root.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function validateNativePersistentRuntimeDirectory(
  runtimeDirectory: string,
  cwd: string,
  product: string,
): Promise<string> {
  if (!isAbsolute(runtimeDirectory) || runtimeDirectory.includes("\0")) {
    throw new Error(
      `Persistent ${product} runtime directory must be an absolute path`,
    );
  }
  const metadata = await lstat(runtimeDirectory).catch(() => null);
  if (
    metadata === null ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(
      `Persistent ${product} runtime directory must be an existing non-symlink directory`,
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(
      `Persistent ${product} runtime directory must not be accessible by group or other users`,
    );
  }
  const runtime = await realpath(runtimeDirectory);
  const workspace = await realpath(cwd);
  if (inside(workspace, runtime) || inside(runtime, workspace)) {
    throw new Error(
      `Persistent ${product} runtime directory must be disjoint from the workspace`,
    );
  }
  return runtime;
}

export async function acquireNativeRuntimeOwner(
  runtimeDirectory: string,
  backend: NativeInteractiveBackend,
): Promise<NativeRuntimeOwner> {
  const lockPath = join(runtimeDirectory, ".organum-code-owner.lock");
  const handle = await open(lockPath, "wx", 0o600).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Persistent ${backend} runtime already has an owner lock; concurrent or stale ownership must be resolved explicitly`,
      );
    }
    throw error;
  });
  try {
    await handle.writeFile(
      `${JSON.stringify({
        schema: 1,
        backend,
        pid: process.pid,
      })}\n`,
      "utf8",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  let closed = false;
  return {
    lockPath,
    async close() {
      if (closed) return;
      closed = true;
      await rm(lockPath, { force: true });
    },
  };
}

function statePath(runtime: AllocatedActorRuntime): string {
  return join(dirname(runtime.bindingPath), "native-session.json");
}

function expectedState(
  runtime: AllocatedActorRuntime,
): NativeInteractiveSessionState {
  return {
    schema: NATIVE_INTERACTIVE_SESSION_SCHEMA,
    revision: 1,
    actor: runtime.actor,
    profile: runtime.profile,
    backend: interactiveBackend(runtime.backend),
    workspace_fingerprint: runtime.workspaceFingerprint,
    root_session_id: nativeInteractiveRootSessionID(runtime),
    native_session_id: deterministicNativeSessionID(runtime),
    resumable: false,
  };
}

function exactState(
  value: unknown,
  expected: NativeInteractiveSessionState,
): NativeInteractiveSessionState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(
      "Native interactive session state must be a JSON object",
    );
  }
  const candidate = value as Record<string, unknown>;
  const keys = [
    "schema",
    "revision",
    "actor",
    "profile",
    "backend",
    "workspace_fingerprint",
    "root_session_id",
    "native_session_id",
    "resumable",
  ].sort();
  if (
    Object.keys(candidate).sort().join("\0") !== keys.join("\0") ||
    candidate.schema !== expected.schema ||
    candidate.actor !== expected.actor ||
    candidate.profile !== expected.profile ||
    candidate.backend !== expected.backend ||
    candidate.workspace_fingerprint !== expected.workspace_fingerprint ||
    candidate.root_session_id !== expected.root_session_id ||
    !Number.isSafeInteger(candidate.revision) ||
    Number(candidate.revision) < 1 ||
    typeof candidate.resumable !== "boolean" ||
    (
      candidate.native_session_id !== null &&
      (
        typeof candidate.native_session_id !== "string" ||
        !UUID_PATTERN.test(candidate.native_session_id)
      )
    )
  ) {
    throw new ConfigurationError(
      "Native interactive session state does not match the actor binding",
    );
  }
  if (
    expected.backend !== "deepcode" &&
    candidate.native_session_id !== expected.native_session_id
  ) {
    throw new ConfigurationError(
      "Native interactive session ID does not match its deterministic actor binding",
    );
  }
  if (candidate.resumable && candidate.native_session_id === null) {
    throw new ConfigurationError(
      "A resumable native interactive session requires a native session ID",
    );
  }
  return candidate as unknown as NativeInteractiveSessionState;
}

async function replaceState(
  path: string,
  state: NativeInteractiveSessionState,
): Promise<void> {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_STATE_BYTES) {
    throw new ConfigurationError("Native interactive session state is too large");
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function loadNativeInteractiveSessionState(
  runtime: AllocatedActorRuntime,
): Promise<NativeInteractiveSessionState> {
  const expected = expectedState(runtime);
  const path = statePath(runtime);
  let bytes: Buffer;
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_SESSION_STATE_BYTES ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new ConfigurationError(
        "Native interactive session state must be one private regular file",
      );
    }
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await replaceState(path, expected);
    return expected;
  }
  try {
    return exactState(JSON.parse(bytes.toString("utf8")), expected);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      "Native interactive session state is not valid JSON",
    );
  }
}

function hasArgument(args: readonly string[], names: readonly string[]): boolean {
  return args.some((argument) =>
    names.some((name) =>
      argument === name ||
      argument.startsWith(`${name}=`) ||
      (
        name.length === 2 &&
        name.startsWith("-") &&
        !name.startsWith("--") &&
        argument.startsWith(name)
      )
    )
  );
}

function assertSupervisorOwnsSessionArguments(
  backend: NativeInteractiveBackend,
  args: readonly string[],
): void {
  const names =
    backend === "claude"
      ? [
          "--continue",
          "-c",
          "--resume",
          "-r",
          "--session-id",
          "--fork-session",
          "--from-pr",
        ]
      : backend === "grok"
        ? [
            "--continue",
            "-c",
            "--resume",
            "-r",
            "--session-id",
            "-s",
            "--fork-session",
            "--restore-code",
          ]
      : backend === "deepcode"
        ? ["--resume", "-r"]
        : backend === "codex"
          ? ["resume", "--last"]
          : ["--resume", "--continue"];
  if (hasArgument(args, names)) {
    throw new ConfigurationError(
      `--actor gives the supervisor ownership of the ${backend} native session; do not pass native resume, continue, fork, or session-ID flags`,
    );
  }
}

function managedArgs(
  backend: NativeInteractiveBackend,
  mode: NativeInteractiveLaunchMode,
  nativeSessionID: string | null,
  args: readonly string[],
): readonly string[] {
  if (mode === "resume") {
    if (nativeSessionID === null) {
      throw new ConfigurationError(
        "Cannot resume a native interactive session without its exact ID",
      );
    }
    return ["--resume", nativeSessionID, ...args];
  }
  if (
    backend === "deepcode" ||
    backend === "codex" ||
    backend === "cursor"
  ) {
    return [...args];
  }
  if (nativeSessionID === null) {
    throw new ConfigurationError(
      "Fixed-session native backend omitted its deterministic session ID",
    );
  }
  return ["--session-id", nativeSessionID, ...args];
}

function idsFromDeepCodeIndex(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && UUID_PATTERN.test(id) ? [id] : [];
  });
}

export async function discoverDeepCodeNativeSessionID(
  runtimeDirectory: string,
): Promise<string | null> {
  const projects = join(runtimeDirectory, "home", ".deepcode", "projects");
  let directories;
  try {
    directories = (await readdir(projects, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .slice(0, 64);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const ids = new Set<string>();
  for (const directory of directories) {
    const path = join(projects, directory.name, "sessions-index.json");
    try {
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > 1024 * 1024
      ) {
        throw new ConfigurationError(
          "Deep Code session index must be a bounded regular file",
        );
      }
      for (const id of idsFromDeepCodeIndex(
        JSON.parse(await readFile(path, "utf8")),
      )) {
        ids.add(id.toLowerCase());
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (ids.size === 0) return null;
  if (ids.size !== 1) {
    throw new ConfigurationError(
      "Deep Code actor runtime contains multiple unbound native sessions; choose a fresh actor instead of guessing a resume target",
    );
  }
  return [...ids][0];
}

export async function planNativeInteractiveLaunch(
  runtime: AllocatedActorRuntime,
  args: readonly string[],
): Promise<NativeInteractiveLaunchPlan> {
  const backend = interactiveBackend(runtime.backend);
  assertSupervisorOwnsSessionArguments(backend, args);
  let state = await loadNativeInteractiveSessionState(runtime);
  if (
    backend === "deepcode" &&
    !state.resumable &&
    state.native_session_id === null
  ) {
    const recovered = await discoverDeepCodeNativeSessionID(
      runtime.runtimeDirectory,
    );
    if (recovered !== null) {
      state = {
        ...state,
        revision: state.revision + 1,
        native_session_id: recovered,
        resumable: true,
      };
      await replaceState(statePath(runtime), state);
    }
  }
  const mode: NativeInteractiveLaunchMode =
    state.resumable ? "resume" : "new";
  return {
    backend,
    rootSessionID: state.root_session_id,
    nativeSessionID: state.native_session_id,
    mode,
    args: managedArgs(
      backend,
      mode,
      state.native_session_id,
      args,
    ),
    statePath: statePath(runtime),
  };
}

export async function finalizeNativeInteractiveLaunch(
  runtime: AllocatedActorRuntime,
  plan: NativeInteractiveLaunchPlan,
): Promise<NativeInteractiveSessionState> {
  const backend = interactiveBackend(runtime.backend);
  if (
    backend !== plan.backend ||
    plan.rootSessionID !== nativeInteractiveRootSessionID(runtime)
  ) {
    throw new ConfigurationError(
      "Native interactive launch plan does not match its actor runtime",
    );
  }
  const current = await loadNativeInteractiveSessionState(runtime);
  const nativeSessionID =
    current.native_session_id ??
    plan.nativeSessionID ??
    (
      backend === "deepcode"
        ? await discoverDeepCodeNativeSessionID(runtime.runtimeDirectory)
        : null
    );
  if (nativeSessionID === null) {
    return current;
  }
  const next: NativeInteractiveSessionState = {
    ...current,
    revision: current.revision + 1,
    native_session_id: nativeSessionID,
    resumable: true,
  };
  await replaceState(statePath(runtime), next);
  return next;
}

export async function ensureNativeRuntimeLayout(
  runtimeDirectory: string,
): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
}
