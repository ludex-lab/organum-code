import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";

export const SIGNED_HUB_SUPERVISOR_SCHEMA =
  "organum-code/signed-hub-supervisor-state/v1" as const;

const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_RECORDS = 4096;
const MAX_CANONICAL_DEPTH = 64;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

export type SemanticAckOutcome = "applied" | "deferred" | "rejected";
export type SignedHubSupervisorPhase =
  | "prepared"
  | "in_flight"
  | "ack_pending"
  | "acked";

export interface SignedHubCandidate {
  envelope: Uint8Array;
  signature: string;
  publicKey: string;
  body: Uint8Array;
}

export interface SignedHubTarget {
  labID: string;
  toID: string;
  toEpoch: number;
}

export interface SignedHubTargetBinding extends SignedHubTarget {}

export interface SignedHubSigner {
  id: string;
  keyID: string;
  keyEpoch: number;
}

export interface SignedHubVerification {
  validSignature: boolean;
  eventID: string;
  signer: SignedHubSigner;
  eventKind: string;
  target: SignedHubTarget | null;
  schemaProblems: readonly string[];
  bodySha256Match: boolean | null;
  ledgerTouched: boolean;
}

export interface SignedHubAdmission {
  admitted: boolean;
  duplicate: boolean;
  eventID: string;
  acceptedSeq: number;
  authorityProjected: boolean;
}

export interface SignedHubAuthority {
  verify(candidate: SignedHubCandidate): Promise<SignedHubVerification>;
  admit(candidate: SignedHubCandidate): Promise<SignedHubAdmission>;
}

export interface SemanticAckRequest {
  eventID: string;
  payloadSha256: string;
  targetCell: string;
  targetEpoch: number;
  outcome: SemanticAckOutcome;
  /** Envelope metadata only; not part of the strict semantic ACK payload. */
  createdAt: string;
}

export interface SemanticAckReceipt {
  eventID: string;
  acceptedSeq: number;
  duplicate: boolean;
}

export interface SemanticAckSink {
  emit(request: SemanticAckRequest): Promise<SemanticAckReceipt>;
}

export interface SignedHubSupervisorRecord {
  schema: typeof SIGNED_HUB_SUPERVISOR_SCHEMA;
  event_id: string;
  payload_sha256: string;
  signer: {
    id: string;
    key_id: string;
    key_epoch: number;
  };
  target: {
    lab_id: string;
    to_id: string;
    to_epoch: number;
  };
  accepted_seq: number;
  admitted_at: string;
  phase: SignedHubSupervisorPhase;
  exposure_started_at: string | null;
  semantic_outcome: SemanticAckOutcome | null;
  semantic_recorded_at: string | null;
  ack_event_id: string | null;
  ack_accepted_seq: number | null;
  acked_at: string | null;
}

export interface SignedHubSupervisorStore {
  putPrepared(
    record: SignedHubSupervisorRecord,
  ): Promise<SignedHubSupervisorRecord>;
  load(eventID: string): Promise<SignedHubSupervisorRecord | null>;
  transition(
    eventID: string,
    update: (
      current: SignedHubSupervisorRecord,
    ) => SignedHubSupervisorRecord,
  ): Promise<SignedHubSupervisorRecord>;
  list(): Promise<SignedHubSupervisorRecord[]>;
}

export interface SignedHubPrepareResult {
  eventID: string;
  acceptedSeq: number;
  phase: SignedHubSupervisorPhase;
  duplicate: boolean;
  body: Buffer | null;
  requiresReconciliation: boolean;
}

export interface SignedHubRecoveryReport {
  ackedEventIDs: string[];
  reconciliationEventIDs: string[];
}

export class SignedHubSupervisorError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "ack"
      | "admission"
      | "canonical"
      | "conflict"
      | "contract"
      | "state"
      | "target"
      | "verification",
  ) {
    super(message);
    this.name = "SignedHubSupervisorError";
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedString(
  value: unknown,
  field: string,
  maximumBytes = 256,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new SignedHubSupervisorError(
      `${field} must be a nonempty bounded string`,
      "contract",
    );
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new SignedHubSupervisorError(
      `${field} must be a positive safe integer`,
      "contract",
    );
  }
  return value as number;
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalJSON(value: unknown, depth = 0): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new SignedHubSupervisorError(
      "Hub envelope exceeds the canonical depth limit",
      "canonical",
    );
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) {
      throw new SignedHubSupervisorError(
        "Hub envelope contains a lone surrogate",
        "canonical",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (
      !Number.isInteger(value) ||
      !Number.isSafeInteger(value) ||
      Math.abs(value) >= 2 ** 53
    ) {
      throw new SignedHubSupervisorError(
        "Hub canonical JSON permits only interoperable integers",
        "canonical",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJSON(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const key of keys) {
      if (
        key.length === 0 ||
        [...key].some((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code < 0x21 || code > 0x7e;
        })
      ) {
        throw new SignedHubSupervisorError(
          "Hub canonical JSON keys must be printable ASCII",
          "canonical",
        );
      }
      if (record[key] === undefined) {
        throw new SignedHubSupervisorError(
          "Hub canonical JSON does not permit undefined values",
          "canonical",
        );
      }
    }
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJSON(record[key], depth + 1)}`,
      )
      .join(",")}}`;
  }
  throw new SignedHubSupervisorError(
    "Hub canonical JSON contains an unsupported value",
    "canonical",
  );
}

export function canonicalHubJSONBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJSON(value), "utf8");
}

interface ParsedMessageEnvelope {
  envelope: Record<string, unknown>;
  eventID: string;
  signer: SignedHubSigner;
  target: SignedHubTarget;
  bodySha256: string;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SignedHubSupervisorError(`${field} must be an object`, "contract");
  }
  return value as Record<string, unknown>;
}

export function parseCanonicalHubMessage(
  envelopeBytes: Uint8Array,
): ParsedMessageEnvelope {
  const bytes = Buffer.from(envelopeBytes);
  if (bytes.length < 2 || bytes.length > MAX_ENVELOPE_BYTES) {
    throw new SignedHubSupervisorError(
      "Hub envelope is empty or oversized",
      "canonical",
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SignedHubSupervisorError(
      "Hub envelope is not valid UTF-8",
      "canonical",
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new SignedHubSupervisorError(
      "Hub envelope is not valid JSON",
      "canonical",
    );
  }
  const envelope = recordValue(decoded, "envelope");
  const canonical = canonicalJSON(envelope);
  if (!Buffer.from(canonical, "utf8").equals(bytes)) {
    throw new SignedHubSupervisorError(
      "Hub envelope bytes are not organum-hub/canonical-json/v1",
      "canonical",
    );
  }
  if (envelope.event_kind !== "message.posted") {
    throw new SignedHubSupervisorError(
      "The supervisor accepts only message.posted intake",
      "contract",
    );
  }
  const signerRecord = recordValue(envelope.signer, "signer");
  const payload = recordValue(envelope.payload, "payload");
  const targetRecord = recordValue(payload.target, "payload.target");
  const bodySha256 = boundedString(
    payload.body_sha256,
    "payload.body_sha256",
    64,
  );
  if (!HEX_64.test(bodySha256)) {
    throw new SignedHubSupervisorError(
      "payload.body_sha256 must be lowercase hex64",
      "contract",
    );
  }
  return {
    envelope,
    eventID: sha256(bytes),
    signer: {
      id: boundedString(signerRecord.id, "signer.id"),
      keyID: boundedString(signerRecord.key_id, "signer.key_id"),
      keyEpoch: positiveInteger(signerRecord.key_epoch, "signer.key_epoch"),
    },
    target: {
      labID: boundedString(targetRecord.lab_id, "target.lab_id"),
      toID: boundedString(targetRecord.to_id, "target.to_id"),
      toEpoch: positiveInteger(targetRecord.to_epoch, "target.to_epoch"),
    },
    bodySha256,
  };
}

function sameSigner(left: SignedHubSigner, right: SignedHubSigner): boolean {
  return (
    left.id === right.id &&
    left.keyID === right.keyID &&
    left.keyEpoch === right.keyEpoch
  );
}

function sameTarget(left: SignedHubTarget, right: SignedHubTarget): boolean {
  return (
    left.labID === right.labID &&
    left.toID === right.toID &&
    left.toEpoch === right.toEpoch
  );
}

function sameImmutableRecord(
  left: SignedHubSupervisorRecord,
  right: SignedHubSupervisorRecord,
): boolean {
  return (
    left.event_id === right.event_id &&
    left.payload_sha256 === right.payload_sha256 &&
    left.signer.id === right.signer.id &&
    left.signer.key_id === right.signer.key_id &&
    left.signer.key_epoch === right.signer.key_epoch &&
    left.target.lab_id === right.target.lab_id &&
    left.target.to_id === right.target.to_id &&
    left.target.to_epoch === right.target.to_epoch &&
    left.accepted_seq === right.accepted_seq
  );
}

function assertBinding(
  target: SignedHubTarget,
  binding: SignedHubTargetBinding,
): void {
  if (!sameTarget(target, binding)) {
    throw new SignedHubSupervisorError(
      "Signed Hub message does not match the active lab, target, and epoch",
      "target",
    );
  }
}

function assertCandidate(candidate: SignedHubCandidate): void {
  if (!HEX_128.test(candidate.signature)) {
    throw new SignedHubSupervisorError(
      "Hub signature must be lowercase hex128",
      "contract",
    );
  }
  if (!HEX_64.test(candidate.publicKey)) {
    throw new SignedHubSupervisorError(
      "Hub public key must be lowercase hex64",
      "contract",
    );
  }
  if (candidate.body.byteLength > MAX_BODY_BYTES) {
    throw new SignedHubSupervisorError(
      `Hub message body exceeds ${MAX_BODY_BYTES} bytes`,
      "contract",
    );
  }
}

function parseDateTime(value: unknown, field: string): string {
  const result = boundedString(value, field, 128);
  if (!Number.isFinite(Date.parse(result))) {
    throw new SignedHubSupervisorError(`${field} is not a date-time`, "state");
  }
  return result;
}

function nullableDateTime(value: unknown, field: string): string | null {
  return value === null ? null : parseDateTime(value, field);
}

function nullableHex64(value: unknown, field: string): string | null {
  if (value === null) return null;
  const result = boundedString(value, field, 64);
  if (!HEX_64.test(result)) {
    throw new SignedHubSupervisorError(`${field} must be hex64`, "state");
  }
  return result;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null ? null : positiveInteger(value, field);
}

function parseStateRecord(value: unknown): SignedHubSupervisorRecord {
  const record = recordValue(value, "signed Hub supervisor state");
  const exactKeys = [
    "schema",
    "event_id",
    "payload_sha256",
    "signer",
    "target",
    "accepted_seq",
    "admitted_at",
    "phase",
    "exposure_started_at",
    "semantic_outcome",
    "semantic_recorded_at",
    "ack_event_id",
    "ack_accepted_seq",
    "acked_at",
  ].sort();
  if (Object.keys(record).sort().join("\0") !== exactKeys.join("\0")) {
    throw new SignedHubSupervisorError(
      "Signed Hub supervisor state has an unknown or missing field",
      "state",
    );
  }
  if (record.schema !== SIGNED_HUB_SUPERVISOR_SCHEMA) {
    throw new SignedHubSupervisorError(
      "Signed Hub supervisor state schema is unsupported",
      "state",
    );
  }
  const signer = recordValue(record.signer, "state.signer");
  const target = recordValue(record.target, "state.target");
  if (
    Object.keys(signer).sort().join("\0") !==
      ["id", "key_epoch", "key_id"].join("\0") ||
    Object.keys(target).sort().join("\0") !==
      ["lab_id", "to_epoch", "to_id"].join("\0")
  ) {
    throw new SignedHubSupervisorError(
      "Signed Hub supervisor signer or target state is not strict",
      "state",
    );
  }
  const phase = record.phase;
  if (
    phase !== "prepared" &&
    phase !== "in_flight" &&
    phase !== "ack_pending" &&
    phase !== "acked"
  ) {
    throw new SignedHubSupervisorError(
      "Signed Hub supervisor phase is invalid",
      "state",
    );
  }
  const semanticOutcome = record.semantic_outcome;
  if (
    semanticOutcome !== null &&
    semanticOutcome !== "applied" &&
    semanticOutcome !== "deferred" &&
    semanticOutcome !== "rejected"
  ) {
    throw new SignedHubSupervisorError(
      "Signed Hub semantic outcome is invalid",
      "state",
    );
  }
  const parsed: SignedHubSupervisorRecord = {
    schema: SIGNED_HUB_SUPERVISOR_SCHEMA,
    event_id: boundedString(record.event_id, "state.event_id", 64),
    payload_sha256: boundedString(
      record.payload_sha256,
      "state.payload_sha256",
      64,
    ),
    signer: {
      id: boundedString(signer.id, "state.signer.id"),
      key_id: boundedString(signer.key_id, "state.signer.key_id"),
      key_epoch: positiveInteger(
        signer.key_epoch,
        "state.signer.key_epoch",
      ),
    },
    target: {
      lab_id: boundedString(target.lab_id, "state.target.lab_id"),
      to_id: boundedString(target.to_id, "state.target.to_id"),
      to_epoch: positiveInteger(target.to_epoch, "state.target.to_epoch"),
    },
    accepted_seq: positiveInteger(record.accepted_seq, "state.accepted_seq"),
    admitted_at: parseDateTime(record.admitted_at, "state.admitted_at"),
    phase,
    exposure_started_at: nullableDateTime(
      record.exposure_started_at,
      "state.exposure_started_at",
    ),
    semantic_outcome: semanticOutcome,
    semantic_recorded_at: nullableDateTime(
      record.semantic_recorded_at,
      "state.semantic_recorded_at",
    ),
    ack_event_id: nullableHex64(record.ack_event_id, "state.ack_event_id"),
    ack_accepted_seq: nullablePositiveInteger(
      record.ack_accepted_seq,
      "state.ack_accepted_seq",
    ),
    acked_at: nullableDateTime(record.acked_at, "state.acked_at"),
  };
  if (!HEX_64.test(parsed.event_id) || !HEX_64.test(parsed.payload_sha256)) {
    throw new SignedHubSupervisorError(
      "Signed Hub state content identities must be lowercase hex64",
      "state",
    );
  }
  if (
    (phase === "prepared" &&
      (parsed.exposure_started_at !== null || semanticOutcome !== null)) ||
    (phase === "in_flight" &&
      (parsed.exposure_started_at === null || semanticOutcome !== null)) ||
    ((phase === "ack_pending" || phase === "acked") &&
      (parsed.exposure_started_at === null ||
        semanticOutcome === null ||
        parsed.semantic_recorded_at === null)) ||
    (phase !== "acked" &&
      (parsed.ack_event_id !== null ||
        parsed.ack_accepted_seq !== null ||
        parsed.acked_at !== null)) ||
    (phase === "acked" &&
      (parsed.ack_event_id === null ||
        parsed.ack_accepted_seq === null ||
        parsed.acked_at === null))
  ) {
    throw new SignedHubSupervisorError(
      "Signed Hub state fields are inconsistent with its phase",
      "state",
    );
  }
  return parsed;
}

async function atomicPrivateWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_RECORD_BYTES) {
    throw new SignedHubSupervisorError(
      "Signed Hub supervisor state is oversized",
      "state",
    );
  }
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    if (process.platform !== "win32") {
      const directory = await open(dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function missing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export class FileSignedHubSupervisorStore
  implements SignedHubSupervisorStore
{
  private readonly root: string;

  constructor(stateDirectory: string) {
    if (
      stateDirectory.trim().length === 0 ||
      stateDirectory.includes("\0") ||
      !isAbsolute(stateDirectory)
    ) {
      throw new SignedHubSupervisorError(
        "Signed Hub state directory must be an absolute path",
        "contract",
      );
    }
    this.root = join(resolve(stateDirectory), "signed-hub-supervisor-v1");
  }

  async putPrepared(
    record: SignedHubSupervisorRecord,
  ): Promise<SignedHubSupervisorRecord> {
    const validated = parseStateRecord(record);
    return await this.withLock(validated.event_id, async () => {
      const current = await this.read(validated.event_id);
      if (current !== null) {
        if (!sameImmutableRecord(current, validated)) {
          throw new SignedHubSupervisorError(
            "Signed Hub event conflicts with its durable supervisor record",
            "conflict",
          );
        }
        return current;
      }
      await atomicPrivateWrite(this.path(validated.event_id), validated);
      return validated;
    });
  }

  async load(eventID: string): Promise<SignedHubSupervisorRecord | null> {
    return await this.read(eventID);
  }

  async transition(
    eventID: string,
    update: (
      current: SignedHubSupervisorRecord,
    ) => SignedHubSupervisorRecord,
  ): Promise<SignedHubSupervisorRecord> {
    return await this.withLock(eventID, async () => {
      const current = await this.read(eventID);
      if (current === null) {
        throw new SignedHubSupervisorError(
          "Signed Hub event has no durable supervisor record",
          "state",
        );
      }
      const next = parseStateRecord(update(current));
      if (!sameImmutableRecord(current, next)) {
        throw new SignedHubSupervisorError(
          "Signed Hub transition changed immutable admission metadata",
          "state",
        );
      }
      await atomicPrivateWrite(this.path(eventID), next);
      return next;
    });
  }

  async list(): Promise<SignedHubSupervisorRecord[]> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.root, { withFileTypes: true });
    const files = entries.filter((entry) => entry.name.endsWith(".json"));
    if (files.length > MAX_RECORDS) {
      throw new SignedHubSupervisorError(
        `Signed Hub supervisor store exceeds ${MAX_RECORDS} records`,
        "state",
      );
    }
    const records: SignedHubSupervisorRecord[] = [];
    for (const entry of files.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new SignedHubSupervisorError(
          "Signed Hub supervisor store contains a non-regular record",
          "state",
        );
      }
      const eventID = entry.name.slice(0, -".json".length);
      records.push(await this.requiredRead(eventID));
    }
    return records;
  }

  private path(eventID: string): string {
    if (!HEX_64.test(eventID)) {
      throw new SignedHubSupervisorError(
        "Signed Hub event ID must be lowercase hex64",
        "contract",
      );
    }
    return join(this.root, `${eventID}.json`);
  }

  private async requiredRead(eventID: string): Promise<SignedHubSupervisorRecord> {
    const record = await this.read(eventID);
    if (record === null) {
      throw new SignedHubSupervisorError(
        "Signed Hub supervisor record disappeared during read",
        "state",
      );
    }
    return record;
  }

  private async read(
    eventID: string,
  ): Promise<SignedHubSupervisorRecord | null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path(eventID));
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (bytes.length > MAX_RECORD_BYTES) {
      throw new SignedHubSupervisorError(
        "Signed Hub supervisor record is oversized",
        "state",
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new SignedHubSupervisorError(
        "Signed Hub supervisor record is invalid JSON",
        "state",
      );
    }
    const record = parseStateRecord(decoded);
    if (record.event_id !== eventID) {
      throw new SignedHubSupervisorError(
        "Signed Hub supervisor filename does not match its event ID",
        "state",
      );
    }
    return record;
  }

  private async withLock<T>(
    eventID: string,
    action: () => Promise<T>,
  ): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, `${eventID}.lock`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let acquired = false;
      try {
        const handle = await open(lock, "wx", 0o600);
        try {
          await handle.writeFile(`${process.pid}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        acquired = true;
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          (error as NodeJS.ErrnoException).code !== "EEXIST"
        ) {
          throw error;
        }
        if (await staleLockOwner(lock)) {
          await unlink(lock).catch((unlinkError: unknown) => {
            if (!missing(unlinkError)) throw unlinkError;
          });
          continue;
        }
      }
      if (acquired) {
        try {
          return await action();
        } finally {
          await unlink(lock);
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    throw new SignedHubSupervisorError(
      "Signed Hub supervisor event lock timed out",
      "state",
    );
  }
}

async function staleLockOwner(path: string): Promise<boolean> {
  let text: string;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32) {
      throw new SignedHubSupervisorError(
        "Signed Hub supervisor lock is not a bounded regular file",
        "state",
      );
    }
    text = await readFile(path, "utf8");
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  if (!/^[1-9][0-9]*\n$/.test(text)) {
    throw new SignedHubSupervisorError(
      "Signed Hub supervisor lock owner is corrupt",
      "state",
    );
  }
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid)) {
    throw new SignedHubSupervisorError(
      "Signed Hub supervisor lock owner is invalid",
      "state",
    );
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function prepareDisposition(
  record: SignedHubSupervisorRecord,
  duplicate: boolean,
  body: Buffer,
): SignedHubPrepareResult {
  return {
    eventID: record.event_id,
    acceptedSeq: record.accepted_seq,
    phase: record.phase,
    duplicate,
    body: record.phase === "prepared" ? Buffer.from(body) : null,
    requiresReconciliation: record.phase === "in_flight",
  };
}

export class SignedHubSupervisor {
  constructor(
    private readonly authority: SignedHubAuthority,
    private readonly acknowledgements: SemanticAckSink,
    private readonly store: SignedHubSupervisorStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async inspect(eventID: string): Promise<SignedHubSupervisorRecord | null> {
    return await this.store.load(eventID);
  }

  async records(): Promise<SignedHubSupervisorRecord[]> {
    return await this.store.list();
  }

  async prepare(
    candidate: SignedHubCandidate,
    binding: SignedHubTargetBinding,
  ): Promise<SignedHubPrepareResult> {
    assertCandidate(candidate);
    const parsed = parseCanonicalHubMessage(candidate.envelope);
    assertBinding(parsed.target, binding);
    const body = Buffer.from(candidate.body);
    if (sha256(body) !== parsed.bodySha256) {
      throw new SignedHubSupervisorError(
        "Hub message body does not match payload.body_sha256",
        "verification",
      );
    }

    const verification = await this.authority.verify(candidate);
    if (
      !verification.validSignature ||
      verification.schemaProblems.length !== 0 ||
      verification.bodySha256Match !== true ||
      verification.ledgerTouched ||
      verification.eventKind !== "message.posted" ||
      verification.eventID !== parsed.eventID ||
      !sameSigner(verification.signer, parsed.signer) ||
      verification.target === null ||
      !sameTarget(verification.target, parsed.target)
    ) {
      throw new SignedHubSupervisorError(
        "Signed Hub verification did not return the exact valid message candidate",
        "verification",
      );
    }

    const admission = await this.authority.admit(candidate);
    if (
      !admission.admitted ||
      admission.eventID !== parsed.eventID ||
      !Number.isSafeInteger(admission.acceptedSeq) ||
      admission.acceptedSeq < 1
    ) {
      throw new SignedHubSupervisorError(
        "Signed Hub admission did not bind the verified event and sequence",
        "admission",
      );
    }

    const admittedAt = this.now().toISOString();
    const prepared: SignedHubSupervisorRecord = {
      schema: SIGNED_HUB_SUPERVISOR_SCHEMA,
      event_id: parsed.eventID,
      payload_sha256: parsed.bodySha256,
      signer: {
        id: parsed.signer.id,
        key_id: parsed.signer.keyID,
        key_epoch: parsed.signer.keyEpoch,
      },
      target: {
        lab_id: parsed.target.labID,
        to_id: parsed.target.toID,
        to_epoch: parsed.target.toEpoch,
      },
      accepted_seq: admission.acceptedSeq,
      admitted_at: admittedAt,
      phase: "prepared",
      exposure_started_at: null,
      semantic_outcome: null,
      semantic_recorded_at: null,
      ack_event_id: null,
      ack_accepted_seq: null,
      acked_at: null,
    };
    const durable = await this.store.putPrepared(prepared);
    return prepareDisposition(durable, admission.duplicate, body);
  }

  async beginExposure(eventID: string): Promise<SignedHubSupervisorRecord> {
    return await this.store.transition(eventID, (current) => {
      if (current.phase !== "prepared") {
        throw new SignedHubSupervisorError(
          `Cannot expose a Signed Hub event in phase ${current.phase}`,
          "state",
        );
      }
      return {
        ...current,
        phase: "in_flight",
        exposure_started_at: this.now().toISOString(),
      };
    });
  }

  async recordOutcome(
    eventID: string,
    outcome: SemanticAckOutcome,
  ): Promise<SignedHubSupervisorRecord> {
    return await this.store.transition(eventID, (current) => {
      if (
        (current.phase === "ack_pending" || current.phase === "acked") &&
        current.semantic_outcome === outcome
      ) {
        return current;
      }
      if (current.phase !== "in_flight") {
        throw new SignedHubSupervisorError(
          `Cannot record a semantic outcome in phase ${current.phase}`,
          "state",
        );
      }
      return {
        ...current,
        phase: "ack_pending",
        semantic_outcome: outcome,
        semantic_recorded_at: this.now().toISOString(),
      };
    });
  }

  async emitPendingAck(eventID: string): Promise<SignedHubSupervisorRecord> {
    const current = await this.store.load(eventID);
    if (current === null) {
      throw new SignedHubSupervisorError(
        "Cannot ACK an unknown Signed Hub event",
        "state",
      );
    }
    if (current.phase === "acked") return current;
    if (
      current.phase !== "ack_pending" ||
      current.semantic_outcome === null ||
      current.semantic_recorded_at === null
    ) {
      throw new SignedHubSupervisorError(
        `Cannot ACK a Signed Hub event in phase ${current.phase}`,
        "state",
      );
    }
    let receipt: SemanticAckReceipt;
    try {
      receipt = await this.acknowledgements.emit({
        eventID: current.event_id,
        payloadSha256: current.payload_sha256,
        targetCell: current.target.to_id,
        targetEpoch: current.target.to_epoch,
        outcome: current.semantic_outcome,
        createdAt: current.semantic_recorded_at,
      });
    } catch {
      throw new SignedHubSupervisorError(
        "Semantic ACK emission failed; the event remains ACK-pending",
        "ack",
      );
    }
    if (
      !HEX_64.test(receipt.eventID) ||
      !Number.isSafeInteger(receipt.acceptedSeq) ||
      receipt.acceptedSeq < 1
    ) {
      throw new SignedHubSupervisorError(
        "Semantic ACK returned an invalid signed receipt",
        "ack",
      );
    }
    return await this.store.transition(eventID, (latest) => {
      if (latest.phase === "acked") return latest;
      if (
        latest.phase !== "ack_pending" ||
        latest.semantic_outcome !== current.semantic_outcome
      ) {
        throw new SignedHubSupervisorError(
          "Semantic ACK state changed while the ACK was in flight",
          "state",
        );
      }
      return {
        ...latest,
        phase: "acked",
        ack_event_id: receipt.eventID,
        ack_accepted_seq: receipt.acceptedSeq,
        acked_at: this.now().toISOString(),
      };
    });
  }

  async recover(): Promise<SignedHubRecoveryReport> {
    const records = await this.store.list();
    const ackedEventIDs: string[] = [];
    const reconciliationEventIDs: string[] = [];
    for (const record of records) {
      if (record.phase === "in_flight") {
        reconciliationEventIDs.push(record.event_id);
      } else if (record.phase === "ack_pending") {
        await this.emitPendingAck(record.event_id);
        ackedEventIDs.push(record.event_id);
      }
    }
    return { ackedEventIDs, reconciliationEventIDs };
  }
}
