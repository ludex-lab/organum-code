import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  buildPersistedCoordinationSystemPacket,
  type CoordinationContextDocument,
} from "./coordination-context.js";
import {
  deriveNativeCellIdentity,
  type CellIdentity,
  type NativeRootBackend,
} from "./organum-identity.js";

export const COORDINATION_CONTINUITY_SCHEMA =
  "organum-code/coordination-continuity/v1" as const;

const MAX_CHECKPOINT_BYTES = 64 * 1024;
const ROOT_ID_MAX_BYTES = 512;
const ROLE_MAX_BYTES = 128;
const PUBLICATION_PHASES = new Set([
  "clean",
  "output_pending",
  "reminded_once",
  "publishing",
  "published",
  "publish_failed",
  "ending",
  "end_failed",
  "shipped",
  "nonconformant",
]);
const RECEIPT_REQUIRED_PHASES = new Set([
  "published",
  "ending",
  "end_failed",
  "shipped",
]);
const RECEIPT_FORBIDDEN_PHASES = new Set([
  "clean",
  "output_pending",
  "publishing",
  "publish_failed",
]);

export interface CoordinationContinuityBinding {
  backend: NativeRootBackend;
  workspaceFingerprint: string;
  rootSessionID: string;
  role: string;
}

export interface CoordinationContinuityCheckpoint {
  schema: typeof COORDINATION_CONTINUITY_SCHEMA;
  revision: number;
  backend: NativeRootBackend;
  workspace_fingerprint: string;
  root_session_id: string;
  identity: CellIdentity;
  role: string;
  saved_at: string;
  context_sha256: string;
  context: CoordinationContextDocument;
}

export class CoordinationContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoordinationContinuityError";
  }
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoordinationContinuityError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new CoordinationContinuityError(
      `${context} contains an unexpected field set`,
    );
  }
}

function boundedString(
  value: unknown,
  context: string,
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new CoordinationContinuityError(`${context} is invalid`);
  }
  return value;
}

function boundedStringAllowEmpty(
  value: unknown,
  context: string,
  maxBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new CoordinationContinuityError(`${context} is invalid`);
  }
  return value;
}

function validateBinding(
  binding: CoordinationContinuityBinding,
): CoordinationContinuityBinding & { identity: CellIdentity } {
  if (!["claude", "grok", "deepcode", "codex"].includes(binding.backend)) {
    throw new CoordinationContinuityError(
      "Continuity backend is unsupported",
    );
  }
  if (!/^[a-f0-9]{24}$/.test(binding.workspaceFingerprint)) {
    throw new CoordinationContinuityError(
      "Continuity workspace fingerprint is invalid",
    );
  }
  const rootSessionID = boundedString(
    binding.rootSessionID,
    "Continuity root session ID",
    ROOT_ID_MAX_BYTES,
  );
  const role = boundedString(binding.role, "Continuity role", ROLE_MAX_BYTES);
  return {
    ...binding,
    rootSessionID,
    role,
    identity: deriveNativeCellIdentity(binding.backend, rootSessionID),
  };
}

function checkpointDigest(binding: CoordinationContinuityBinding): string {
  return createHash("sha256")
    .update("organum-code/coordination-continuity-path/v1")
    .update("\0")
    .update(binding.backend)
    .update("\0")
    .update(binding.workspaceFingerprint)
    .update("\0")
    .update(binding.rootSessionID)
    .digest("hex");
}

function contextDigest(context: CoordinationContextDocument): string {
  return createHash("sha256")
    .update(JSON.stringify(context), "utf8")
    .digest("hex");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function validateContext(
  value: unknown,
  binding: ReturnType<typeof validateBinding>,
): CoordinationContextDocument {
  const context = object(value, "Continuity context");
  exactKeys(
    context,
    [
      "protocol",
      "discipline",
      "health",
      "actor",
      "presence",
      "charter",
      "goal",
      "publication",
      "project",
      "field",
    ],
    "Continuity context",
  );
  const actor = object(context.actor, "Continuity context actor");
  if (actor.cell !== binding.identity || actor.role !== binding.role) {
    throw new CoordinationContinuityError(
      "Continuity context actor does not match its root binding",
    );
  }
  const goal = object(context.goal, "Continuity context goal");
  if (
    !["canonical", "missing", "unverified"].includes(String(goal.status)) ||
    !Array.isArray(goal.items)
  ) {
    throw new CoordinationContinuityError(
      "Continuity current-goal state is invalid",
    );
  }
  if (goal.status === "canonical") {
    if (goal.items.length !== 1) {
      throw new CoordinationContinuityError(
        "Canonical continuity goal must contain exactly one item",
      );
    }
    const item = object(goal.items[0], "Canonical continuity goal item");
    for (const field of ["file", "from", "from_id", "ts", "body"]) {
      boundedString(item[field], `Canonical continuity goal ${field}`, 4 * 1024);
    }
    boundedStringAllowEmpty(
      item.thread,
      "Canonical continuity goal thread",
      4 * 1024,
    );
    if (item.topic !== "goal") {
      throw new CoordinationContinuityError(
        "Canonical continuity goal topic must be goal",
      );
    }
  }
  if (context.publication !== null) {
    const publication = object(
      context.publication,
      "Continuity publication obligation",
    );
    exactKeys(
      publication,
      [
        "protocol",
        "phase",
        "turn_id",
        "reminders",
        "receipt",
        "last_error",
        "note_error",
        "terminal_required",
      ],
      "Continuity publication obligation",
    );
    if (
      publication.protocol !== 1 ||
      publication.terminal_required !== true ||
      typeof publication.phase !== "string" ||
      !PUBLICATION_PHASES.has(publication.phase)
    ) {
      throw new CoordinationContinuityError(
        "Continuity publication obligation is invalid",
      );
    }
    if (
      publication.phase !== "clean" &&
      boundedString(
          publication.turn_id,
          "Continuity publication turn",
          256,
        ).length === 0
    ) {
      throw new CoordinationContinuityError(
        "Continuity publication turn is missing",
      );
    }
    if (
      (publication.reminders !== 0 && publication.reminders !== 1) ||
      (publication.last_error !== null &&
        typeof publication.last_error !== "string") ||
      (publication.note_error !== null &&
        typeof publication.note_error !== "string")
    ) {
      throw new CoordinationContinuityError(
        "Continuity publication metadata is invalid",
      );
    }
    const receiptRequired = RECEIPT_REQUIRED_PHASES.has(publication.phase);
    const receiptForbidden = RECEIPT_FORBIDDEN_PHASES.has(publication.phase);
    if (
      (receiptRequired && publication.receipt === null) ||
      (receiptForbidden && publication.receipt !== null)
    ) {
      throw new CoordinationContinuityError(
        "Continuity publication receipt does not match its phase",
      );
    }
    if (publication.receipt !== null) {
      const receipt = object(
        publication.receipt,
        "Continuity publication receipt",
      );
      exactKeys(
        receipt,
        [
          "channel",
          "to",
          "file",
          "from_id",
          "idem_key",
          "topic",
          "body_bytes",
          "body_sha256",
        ],
        "Continuity publication receipt",
      );
      if (
        (receipt.channel !== "agora" && receipt.channel !== "relay") ||
        (receipt.channel === "agora" && receipt.to !== null) ||
        (receipt.channel === "relay" &&
          (typeof receipt.to !== "string" ||
            receipt.to.trim().length === 0)) ||
        typeof receipt.file !== "string" ||
        !receipt.file.endsWith(".md") ||
        receipt.file.startsWith(".") ||
        receipt.file.includes("/") ||
        receipt.file.includes("\\") ||
        receipt.from_id !== binding.identity ||
        typeof receipt.idem_key !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.idem_key) ||
        (receipt.topic !== null && typeof receipt.topic !== "string") ||
        !Number.isSafeInteger(receipt.body_bytes) ||
        Number(receipt.body_bytes) < 1 ||
        Number(receipt.body_bytes) > 64 * 1024 ||
        typeof receipt.body_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(receipt.body_sha256)
      ) {
        throw new CoordinationContinuityError(
          "Continuity publication receipt is invalid",
        );
      }
    }
    if (publication.phase === "shipped" && publication.last_error !== null) {
      throw new CoordinationContinuityError(
        "Shipped continuity publication cannot retain an error",
      );
    }
  }
  try {
    buildPersistedCoordinationSystemPacket(
      context as unknown as CoordinationContextDocument,
    );
  } catch (error) {
    throw new CoordinationContinuityError(
      `Continuity packet is not restorable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return JSON.parse(
    JSON.stringify(context),
  ) as CoordinationContextDocument;
}

function validateCheckpoint(
  value: unknown,
  binding: ReturnType<typeof validateBinding>,
): CoordinationContinuityCheckpoint {
  const checkpoint = object(value, "Continuity checkpoint");
  exactKeys(
    checkpoint,
    [
      "schema",
      "revision",
      "backend",
      "workspace_fingerprint",
      "root_session_id",
      "identity",
      "role",
      "saved_at",
      "context_sha256",
      "context",
    ],
    "Continuity checkpoint",
  );
  if (
    checkpoint.schema !== COORDINATION_CONTINUITY_SCHEMA ||
    checkpoint.backend !== binding.backend ||
    checkpoint.workspace_fingerprint !== binding.workspaceFingerprint ||
    checkpoint.root_session_id !== binding.rootSessionID ||
    checkpoint.identity !== binding.identity ||
    checkpoint.role !== binding.role
  ) {
    throw new CoordinationContinuityError(
      "Continuity checkpoint does not match its root binding",
    );
  }
  if (
    !Number.isSafeInteger(checkpoint.revision) ||
    Number(checkpoint.revision) < 1
  ) {
    throw new CoordinationContinuityError(
      "Continuity checkpoint revision is invalid",
    );
  }
  const savedAt = boundedString(
    checkpoint.saved_at,
    "Continuity checkpoint timestamp",
    128,
  );
  if (!Number.isFinite(Date.parse(savedAt))) {
    throw new CoordinationContinuityError(
      "Continuity checkpoint timestamp is invalid",
    );
  }
  if (
    typeof checkpoint.context_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(checkpoint.context_sha256)
  ) {
    throw new CoordinationContinuityError(
      "Continuity checkpoint digest is invalid",
    );
  }
  const context = validateContext(checkpoint.context, binding);
  if (contextDigest(context) !== checkpoint.context_sha256) {
    throw new CoordinationContinuityError(
      "Continuity checkpoint context digest does not match",
    );
  }
  return {
    schema: COORDINATION_CONTINUITY_SCHEMA,
    revision: Number(checkpoint.revision),
    backend: binding.backend,
    workspace_fingerprint: binding.workspaceFingerprint,
    root_session_id: binding.rootSessionID,
    identity: binding.identity,
    role: binding.role,
    saved_at: savedAt,
    context_sha256: checkpoint.context_sha256,
    context,
  };
}

export class FileCoordinationContinuityStore {
  readonly #root: string;
  readonly #now: () => Date;

  constructor(
    stateDirectory: string,
    now: () => Date = () => new Date(),
  ) {
    if (
      stateDirectory.trim().length === 0 ||
      stateDirectory.includes("\0") ||
      !isAbsolute(stateDirectory)
    ) {
      throw new CoordinationContinuityError(
        "Continuity state directory must be a nonempty absolute path",
      );
    }
    this.#root = join(
      resolve(stateDirectory),
      "coordination-continuity-v1",
    );
    this.#now = now;
  }

  async save(
    bindingInput: CoordinationContinuityBinding,
    contextValue: CoordinationContextDocument,
  ): Promise<CoordinationContinuityCheckpoint> {
    const binding = validateBinding(bindingInput);
    const context = validateContext(contextValue, binding);
    const existing = await this.load(binding);
    const checkpoint: CoordinationContinuityCheckpoint = {
      schema: COORDINATION_CONTINUITY_SCHEMA,
      revision: (existing?.revision ?? 0) + 1,
      backend: binding.backend,
      workspace_fingerprint: binding.workspaceFingerprint,
      root_session_id: binding.rootSessionID,
      identity: binding.identity,
      role: binding.role,
      saved_at: this.#now().toISOString(),
      context_sha256: contextDigest(context),
      context,
    };
    const serialized = `${JSON.stringify(checkpoint, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new CoordinationContinuityError(
        "Continuity checkpoint exceeds its byte limit",
      );
    }
    const directory = await this.ensureRoot();
    const destination = join(
      directory,
      `${checkpointDigest(binding)}.json`,
    );
    const temporary = join(
      directory,
      `${checkpointDigest(binding)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, destination);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
    return await this.read(destination, binding);
  }

  async load(
    bindingInput: CoordinationContinuityBinding,
  ): Promise<CoordinationContinuityCheckpoint | null> {
    const binding = validateBinding(bindingInput);
    const directory = await this.ensureRoot();
    const path = join(directory, `${checkpointDigest(binding)}.json`);
    try {
      return await this.read(path, binding);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async ensureRoot(): Promise<string> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new CoordinationContinuityError(
        "Continuity state root must be a real directory",
      );
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new CoordinationContinuityError(
        "Continuity state root must be private",
      );
    }
    return await realpath(this.#root);
  }

  private async read(
    path: string,
    binding: ReturnType<typeof validateBinding>,
  ): Promise<CoordinationContinuityCheckpoint> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new CoordinationContinuityError(
        "Continuity checkpoint must be a regular file",
      );
    }
    if (
      metadata.size <= 0 ||
      metadata.size > MAX_CHECKPOINT_BYTES ||
      (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
    ) {
      throw new CoordinationContinuityError(
        "Continuity checkpoint size or permissions are invalid",
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new CoordinationContinuityError(
        "Continuity checkpoint is not valid JSON",
      );
    }
    return validateCheckpoint(decoded, binding);
  }
}
