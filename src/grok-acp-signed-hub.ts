import { readFile, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

import type { AllocatedActorRuntime } from "./actor-runtime.js";
import {
  ORGANUM_CODE_SIGNED_HUB_BIN_ENV,
  ORGANUM_CODE_SIGNED_HUB_DIR_ENV,
  ORGANUM_CODE_SIGNED_HUB_PIN,
  ORGANUM_CODE_SIGNED_HUB_PROTOCOL_ENV,
  OrganumHubCliAuthority,
  OrganumHubSemanticAckSink,
} from "./organum-hub-cli.js";
import {
  OrganumHubKeychainSemanticAckSink,
  type HubKeychainReader,
} from "./organum-hub-keychain.js";
import { ConfigurationError } from "./provider-profile.js";
import {
  FileSignedHubSupervisorStore,
  SignedHubSupervisor,
  type SignedHubCandidate,
  type SignedHubPrepareResult,
  type SemanticAckSink,
  type SignedHubSupervisorRecord,
  type SignedHubTargetBinding,
} from "./signed-hub-supervisor.js";

export const ORGANUM_CODE_SIGNED_HUB_TURN_FILE_ENV =
  "ORGANUM_CODE_SIGNED_HUB_TURN_FILE" as const;
export const GROK_ACP_SIGNED_HUB_TURN_SCHEMA =
  "organum-code/grok-acp-signed-hub-turn/v1" as const;
export const GROK_ACP_SIGNED_HUB_TURN_SCHEMA_V2 =
  "organum-code/grok-acp-signed-hub-turn/v2" as const;

const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const HEX_64 = /^[0-9a-f]{64}$/;

export interface GrokAcpSignedHubTurn {
  supervisor: SignedHubSupervisor;
  candidate: SignedHubCandidate;
  binding: SignedHubTargetBinding;
  preflightAcknowledgement?: () => Promise<void>;
}

export type GrokAcpSignedHubNoTurnDisposition =
  | "ack_recovered"
  | "already_acked"
  | "reconciliation_required";

export class GrokAcpSignedHubNoTurnError extends Error {
  constructor(
    readonly disposition: GrokAcpSignedHubNoTurnDisposition,
    readonly eventID: string,
  ) {
    super(
      disposition === "ack_recovered"
        ? `Recovered the pending semantic ACK for Signed Hub event ${eventID}; no ACP turn was launched`
        : disposition === "already_acked"
          ? `Signed Hub event ${eventID} is already ACKed; no ACP turn was launched`
          : `Signed Hub event ${eventID} is in flight and requires operator reconciliation`,
    );
    this.name = "GrokAcpSignedHubNoTurnError";
  }
}

export interface GrokAcpSignedHubSnapshot {
  eventID: string;
  sourceAcceptedSeq: number;
  semanticOutcome: "applied" | "deferred";
  ackEventID: string;
  ackAcceptedSeq: number;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigurationError(`${context} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new ConfigurationError(`${context} has unknown or missing fields`);
  }
  return record;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  context: string,
  maximumBytes = 4096,
): string {
  const result = value[field];
  if (
    typeof result !== "string" ||
    result.trim().length === 0 ||
    result.includes("\0") ||
    Buffer.byteLength(result, "utf8") > maximumBytes
  ) {
    throw new ConfigurationError(`${context}.${field} is invalid`);
  }
  return result;
}

function positiveInteger(
  value: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const result = value[field];
  if (!Number.isSafeInteger(result) || (result as number) < 1) {
    throw new ConfigurationError(`${context}.${field} must be a positive integer`);
  }
  return result as number;
}

async function boundedPrivateFile(
  path: string,
  maximumBytes: number,
  workspace: string,
  context: string,
): Promise<{ path: string; bytes: Buffer }> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ConfigurationError(`${context} must be an absolute path`);
  }
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new ConfigurationError(
      `${context} must be a bounded private regular non-symlink file`,
    );
  }
  const canonical = await realpath(path);
  if (inside(workspace, canonical)) {
    throw new ConfigurationError(
      `${context} must stay outside the backend-visible workspace`,
    );
  }
  return { path: canonical, bytes: await readFile(canonical) };
}

async function privateReferenceFile(
  path: string,
  workspace: string,
  context: string,
): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ConfigurationError(`${context} must be an absolute path`);
  }
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 1 ||
    metadata.size > 4096 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new ConfigurationError(
      `${context} must be a bounded private regular non-symlink file`,
    );
  }
  const canonical = await realpath(path);
  if (inside(workspace, canonical)) {
    throw new ConfigurationError(
      `${context} must stay outside the backend-visible workspace`,
    );
  }
  return canonical;
}

interface ParsedTurnManifest {
  envelopePath: string;
  signaturePath: string;
  bodyPath: string;
  senderPublicKey: string;
  binding: SignedHubTargetBinding;
  ack: {
    keySource:
      | { kind: "file"; path: string }
      | { kind: "keychain"; service: string; account: string };
    signer: string;
    keyID: string;
    keyEpoch: number;
    publicKey: string;
    machineID: string;
  };
}

function parseManifest(value: unknown): ParsedTurnManifest {
  const manifest = exactObject(
    value,
    [
      "schema",
      "envelope_path",
      "signature_path",
      "body_path",
      "sender_pubkey",
      "target",
      "ack",
    ],
    "Signed Hub turn manifest",
  );
  if (
    manifest.schema !== GROK_ACP_SIGNED_HUB_TURN_SCHEMA &&
    manifest.schema !== GROK_ACP_SIGNED_HUB_TURN_SCHEMA_V2
  ) {
    throw new ConfigurationError("Signed Hub turn manifest schema is unsupported");
  }
  const target = exactObject(
    manifest.target,
    ["lab_id", "to_id", "to_epoch"],
    "Signed Hub turn target",
  );
  const ack = exactObject(
    manifest.ack,
    manifest.schema === GROK_ACP_SIGNED_HUB_TURN_SCHEMA
      ? ["key_file", "signer", "key_id", "key_epoch", "pubkey", "machine_id"]
      : ["key_source", "signer", "key_id", "key_epoch", "pubkey", "machine_id"],
    "Signed Hub turn ACK",
  );
  let keySource: ParsedTurnManifest["ack"]["keySource"];
  if (manifest.schema === GROK_ACP_SIGNED_HUB_TURN_SCHEMA) {
    keySource = {
      kind: "file",
      path: stringField(ack, "key_file", "Signed Hub turn ACK"),
    };
  } else {
    const key = exactObject(
      ack.key_source,
      typeof ack.key_source === "object" &&
          ack.key_source !== null &&
          !Array.isArray(ack.key_source) &&
          (ack.key_source as Record<string, unknown>).kind === "file"
        ? ["kind", "path"]
        : ["kind", "service", "account"],
      "Signed Hub turn ACK key source",
    );
    if (key.kind === "file") {
      keySource = {
        kind: "file",
        path: stringField(key, "path", "Signed Hub turn ACK key source"),
      };
    } else if (key.kind === "keychain") {
      keySource = {
        kind: "keychain",
        service: stringField(
          key,
          "service",
          "Signed Hub turn ACK key source",
          512,
        ),
        account: stringField(
          key,
          "account",
          "Signed Hub turn ACK key source",
          512,
        ),
      };
    } else {
      throw new ConfigurationError(
        "Signed Hub turn ACK key source kind must be file or keychain",
      );
    }
  }
  const senderPublicKey = stringField(
    manifest,
    "sender_pubkey",
    "Signed Hub turn manifest",
    64,
  );
  const ackPublicKey = stringField(
    ack,
    "pubkey",
    "Signed Hub turn ACK",
    64,
  );
  if (!HEX_64.test(senderPublicKey) || !HEX_64.test(ackPublicKey)) {
    throw new ConfigurationError(
      "Signed Hub turn public keys must be lowercase hex64",
    );
  }
  return {
    envelopePath: stringField(
      manifest,
      "envelope_path",
      "Signed Hub turn manifest",
    ),
    signaturePath: stringField(
      manifest,
      "signature_path",
      "Signed Hub turn manifest",
    ),
    bodyPath: stringField(
      manifest,
      "body_path",
      "Signed Hub turn manifest",
    ),
    senderPublicKey,
    binding: {
      labID: stringField(target, "lab_id", "Signed Hub turn target", 256),
      toID: stringField(target, "to_id", "Signed Hub turn target", 256),
      toEpoch: positiveInteger(target, "to_epoch", "Signed Hub turn target"),
    },
    ack: {
      keySource,
      signer: stringField(ack, "signer", "Signed Hub turn ACK", 256),
      keyID: stringField(ack, "key_id", "Signed Hub turn ACK", 256),
      keyEpoch: positiveInteger(ack, "key_epoch", "Signed Hub turn ACK"),
      publicKey: ackPublicKey,
      machineID: stringField(ack, "machine_id", "Signed Hub turn ACK", 256),
    },
  };
}

export async function loadGrokAcpSignedHubTurn(options: {
  environment: NodeJS.ProcessEnv;
  directory: string;
  actorRuntime: AllocatedActorRuntime | null;
  keychain?: {
    platform?: NodeJS.Platform;
    read?: HubKeychainReader;
  };
}): Promise<GrokAcpSignedHubTurn> {
  if (options.actorRuntime === null) {
    throw new ConfigurationError(
      "Signed Hub turns require --actor for durable restart ownership",
    );
  }
  const workspace = await realpath(resolve(options.directory));
  const manifestValue = options.environment[
    ORGANUM_CODE_SIGNED_HUB_TURN_FILE_ENV
  ]?.trim();
  if (manifestValue === undefined || manifestValue.length === 0) {
    throw new ConfigurationError(
      `${ORGANUM_CODE_SIGNED_HUB_TURN_FILE_ENV} is required for a Signed Hub backend turn`,
    );
  }
  const manifestFile = await boundedPrivateFile(
    manifestValue,
    MAX_MANIFEST_BYTES,
    workspace,
    ORGANUM_CODE_SIGNED_HUB_TURN_FILE_ENV,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestFile.bytes.toString("utf8"));
  } catch {
    throw new ConfigurationError("Signed Hub turn manifest is invalid JSON");
  }
  const manifest = parseManifest(decoded);
  const protocol = options.environment[
    ORGANUM_CODE_SIGNED_HUB_PROTOCOL_ENV
  ]?.trim();
  if (protocol !== ORGANUM_CODE_SIGNED_HUB_PIN) {
    throw new ConfigurationError(
      `${ORGANUM_CODE_SIGNED_HUB_PROTOCOL_ENV} must equal ${ORGANUM_CODE_SIGNED_HUB_PIN}`,
    );
  }
  const rawHubDirectory = options.environment[
    ORGANUM_CODE_SIGNED_HUB_DIR_ENV
  ]?.trim();
  if (
    rawHubDirectory === undefined ||
    !isAbsolute(rawHubDirectory) ||
    rawHubDirectory.includes("\0")
  ) {
    throw new ConfigurationError(
      `${ORGANUM_CODE_SIGNED_HUB_DIR_ENV} must be an absolute path`,
    );
  }
  const hubDirectory = await realpath(rawHubDirectory);
  const supervisorState = dirname(options.actorRuntime.bindingPath);
  if (
    inside(workspace, supervisorState) ||
    inside(supervisorState, workspace) ||
    inside(hubDirectory, supervisorState) ||
    inside(supervisorState, hubDirectory)
  ) {
    throw new ConfigurationError(
      "Signed Hub supervisor state must be disjoint from workspace and Hub",
    );
  }
  const [envelope, signature, body] = await Promise.all([
    boundedPrivateFile(
      manifest.envelopePath,
      MAX_ENVELOPE_BYTES,
      workspace,
      "Signed Hub envelope",
    ),
    boundedPrivateFile(
      manifest.signaturePath,
      MAX_SIGNATURE_BYTES,
      workspace,
      "Signed Hub signature",
    ),
    boundedPrivateFile(
      manifest.bodyPath,
      MAX_BODY_BYTES,
      workspace,
      "Signed Hub body",
    ),
  ]);
  const binary = options.environment[ORGANUM_CODE_SIGNED_HUB_BIN_ENV]?.trim() ||
    "organum-hub";
  const authority = new OrganumHubCliAuthority({
    hubDirectory,
    binary,
    cwd: workspace,
    env: options.environment,
  });
  const commonAck = {
    hubDirectory,
    binary,
    cwd: workspace,
    env: options.environment,
    signer: manifest.ack.signer,
    keyID: manifest.ack.keyID,
    keyEpoch: manifest.ack.keyEpoch,
    publicKey: manifest.ack.publicKey,
    machineID: manifest.ack.machineID,
  };
  let acknowledgements: SemanticAckSink;
  if (manifest.ack.keySource.kind === "file") {
    const keyFile = await privateReferenceFile(
      manifest.ack.keySource.path,
      workspace,
      "Signed Hub ACK key",
    );
    acknowledgements = new OrganumHubSemanticAckSink({
      ...commonAck,
      keyFile,
    });
  } else {
    acknowledgements = new OrganumHubKeychainSemanticAckSink({
      ...commonAck,
      keychainService: manifest.ack.keySource.service,
      keychainAccount: manifest.ack.keySource.account,
      platform: options.keychain?.platform,
      keychainRead: options.keychain?.read,
    });
  }
  return {
    supervisor: new SignedHubSupervisor(
      authority,
      acknowledgements,
      new FileSignedHubSupervisorStore(supervisorState),
    ),
    candidate: {
      envelope: envelope.bytes,
      signature: signature.bytes.toString("utf8").trim(),
      publicKey: manifest.senderPublicKey,
      body: body.bytes,
    },
    binding: manifest.binding,
    preflightAcknowledgement: async () => {
      if (acknowledgements instanceof OrganumHubSemanticAckSink) {
        await acknowledgements.preflight();
      } else if (
        acknowledgements instanceof OrganumHubKeychainSemanticAckSink
      ) {
        await acknowledgements.preflight();
      }
    },
  };
}

function signedPrompt(body: Buffer): string {
  let prompt: string;
  try {
    prompt = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ConfigurationError("Signed Hub critic/review body must be UTF-8 text");
  }
  if (
    prompt.trim().length === 0 ||
    prompt.includes("\0") ||
    Buffer.byteLength(prompt, "utf8") > 64 * 1024
  ) {
    throw new ConfigurationError(
      "Signed Hub critic/review body must be nonempty and at most 65536 UTF-8 bytes",
    );
  }
  return prompt;
}

export class GrokAcpSignedHubLifecycle {
  private preparation: SignedHubPrepareResult | null = null;
  private exposureStarted = false;
  private completed: GrokAcpSignedHubSnapshot | null = null;

  constructor(private readonly turn: GrokAcpSignedHubTurn) {}

  async prepare(): Promise<string> {
    if (this.preparation !== null) {
      if (this.preparation.body === null) {
        throw new ConfigurationError("Signed Hub preparation lost its bounded body");
      }
      return signedPrompt(this.preparation.body);
    }
    const prepared = await this.turn.supervisor.prepare(
      this.turn.candidate,
      this.turn.binding,
    );
    if (prepared.phase === "ack_pending") {
      await this.turn.supervisor.emitPendingAck(prepared.eventID);
      throw new GrokAcpSignedHubNoTurnError(
        "ack_recovered",
        prepared.eventID,
      );
    }
    if (prepared.phase === "acked") {
      throw new GrokAcpSignedHubNoTurnError(
        "already_acked",
        prepared.eventID,
      );
    }
    if (prepared.phase === "in_flight") {
      throw new GrokAcpSignedHubNoTurnError(
        "reconciliation_required",
        prepared.eventID,
      );
    }
    if (prepared.body === null) {
      throw new ConfigurationError("Prepared Signed Hub turn has no bounded body");
    }
    await this.turn.preflightAcknowledgement?.();
    this.preparation = prepared;
    return signedPrompt(prepared.body);
  }

  async beginExposure(): Promise<void> {
    if (this.preparation === null || this.exposureStarted) {
      throw new ConfigurationError(
        "Signed Hub exposure must begin exactly once after preparation",
      );
    }
    await this.turn.supervisor.beginExposure(this.preparation.eventID);
    this.exposureStarted = true;
  }

  async complete(successful: boolean): Promise<GrokAcpSignedHubSnapshot> {
    if (this.completed !== null) return this.completed;
    if (this.preparation === null || !this.exposureStarted) {
      throw new ConfigurationError(
        "Signed Hub semantic completion requires an exposed turn",
      );
    }
    const outcome = successful ? "applied" : "deferred";
    await this.turn.supervisor.recordOutcome(
      this.preparation.eventID,
      outcome,
    );
    const acked: SignedHubSupervisorRecord =
      await this.turn.supervisor.emitPendingAck(this.preparation.eventID);
    if (
      acked.ack_event_id === null ||
      acked.ack_accepted_seq === null
    ) {
      throw new ConfigurationError("Signed Hub ACK completed without a receipt");
    }
    this.completed = {
      eventID: this.preparation.eventID,
      sourceAcceptedSeq: this.preparation.acceptedSeq,
      semanticOutcome: outcome,
      ackEventID: acked.ack_event_id,
      ackAcceptedSeq: acked.ack_accepted_seq,
    };
    return this.completed;
  }
}

// The first consumer was Grok ACP, but the manifest, authority, durable state,
// and ACK lifecycle are backend-neutral. Keep the original names for the
// shipped Grok contract while exposing neutral names to later product adapters.
export type SignedHubTurn = GrokAcpSignedHubTurn;
export type SignedHubSnapshot = GrokAcpSignedHubSnapshot;
export const loadSignedHubTurn = loadGrokAcpSignedHubTurn;
export {
  GrokAcpSignedHubLifecycle as SignedHubLifecycle,
  GrokAcpSignedHubNoTurnError as SignedHubNoTurnError,
};
