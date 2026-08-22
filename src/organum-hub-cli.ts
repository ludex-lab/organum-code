import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  buildOrganumCliEnvironment,
  executeOrganumCommand,
  OrganumCommandError,
  type OrganumCommandExecutor,
  type OrganumCommandResult,
} from "./organum-cli.js";
import type {
  SignedHubAdmission,
  SignedHubAuthority,
  SignedHubCandidate,
  SignedHubSigner,
  SignedHubTarget,
  SignedHubVerification,
  SemanticAckRequest,
  SemanticAckReceipt,
  SemanticAckSink,
} from "./signed-hub-supervisor.js";
import { canonicalHubJSONBytes } from "./signed-hub-supervisor.js";

export const ORGANUM_CODE_SIGNED_HUB_BIN_ENV =
  "ORGANUM_CODE_SIGNED_HUB_BIN" as const;
export const ORGANUM_CODE_SIGNED_HUB_DIR_ENV =
  "ORGANUM_CODE_SIGNED_HUB_DIR" as const;
export const ORGANUM_CODE_SIGNED_HUB_PROTOCOL_ENV =
  "ORGANUM_CODE_SIGNED_HUB_PROTOCOL" as const;
export const ORGANUM_CODE_SIGNED_HUB_WIRE_URL_ENV =
  "ORGANUM_CODE_SIGNED_HUB_WIRE_URL" as const;
export const ORGANUM_CODE_SIGNED_HUB_CARRIER_TOKEN_ENV =
  "ORGANUM_CODE_SIGNED_HUB_CARRIER_TOKEN" as const;
export const ORGANUM_CODE_SIGNED_HUB_PIN = "0.4.5" as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STDOUT_LIMIT = 1024 * 1024;
const DEFAULT_STDERR_LIMIT = 32 * 1024;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;

export interface OrganumHubCliOptions {
  hubDirectory: string;
  binary?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  executor?: OrganumCommandExecutor;
}

export interface OrganumHubSemanticAckOptions extends OrganumHubCliOptions {
  keyFile: string;
  signer: string;
  keyID: string;
  keyEpoch: number;
  publicKey: string;
  machineID: string;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OrganumCommandError(
      `organum-hub ${context} returned a non-object`,
      "contract",
    );
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const result = value[field];
  if (
    typeof result !== "string" ||
    result.trim().length === 0 ||
    result.includes("\0") ||
    Buffer.byteLength(result, "utf8") > 512
  ) {
    throw new OrganumCommandError(
      `organum-hub ${context}.${field} is invalid`,
      "contract",
    );
  }
  return result;
}

function booleanField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): boolean {
  const result = value[field];
  if (typeof result !== "boolean") {
    throw new OrganumCommandError(
      `organum-hub ${context}.${field} is invalid`,
      "contract",
    );
  }
  return result;
}

function positiveIntegerField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): number {
  const result = value[field];
  if (!Number.isSafeInteger(result) || (result as number) < 1) {
    throw new OrganumCommandError(
      `organum-hub ${context}.${field} is invalid`,
      "contract",
    );
  }
  return result as number;
}

function nullableBooleanField(
  value: Record<string, unknown>,
  field: string,
  context: string,
): boolean | null {
  const result = value[field];
  if (result !== null && typeof result !== "boolean") {
    throw new OrganumCommandError(
      `organum-hub ${context}.${field} is invalid`,
      "contract",
    );
  }
  return result as boolean | null;
}

function hex64Field(
  value: Record<string, unknown>,
  field: string,
  context: string,
): string {
  const result = stringField(value, field, context);
  if (!HEX_64.test(result)) {
    throw new OrganumCommandError(
      `organum-hub ${context}.${field} must be lowercase hex64`,
      "contract",
    );
  }
  return result;
}

function signer(value: unknown): SignedHubSigner {
  const result = record(value, "verify-envelope.signer");
  return {
    id: stringField(result, "id", "verify-envelope.signer"),
    keyID: stringField(result, "key_id", "verify-envelope.signer"),
    keyEpoch: positiveIntegerField(
      result,
      "key_epoch",
      "verify-envelope.signer",
    ),
  };
}

function target(value: unknown): SignedHubTarget | null {
  if (value === null) return null;
  const result = record(value, "verify-envelope.target");
  return {
    labID: stringField(result, "lab_id", "verify-envelope.target"),
    toID: stringField(result, "to_id", "verify-envelope.target"),
    toEpoch: positiveIntegerField(
      result,
      "to_epoch",
      "verify-envelope.target",
    ),
  };
}

function schemaProblems(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (entry) =>
        typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > 2048,
    )
  ) {
    throw new OrganumCommandError(
      "organum-hub verify-envelope.schema_problems is invalid",
      "contract",
    );
  }
  return [...value] as string[];
}

async function stagedCandidate<T>(
  candidate: SignedHubCandidate,
  action: (paths: {
    envelope: string;
    signature: string;
    body: string;
  }) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "organum-code-signed-hub-"));
  await chmod(directory, 0o700);
  const paths = {
    envelope: join(directory, "envelope.json"),
    signature: join(directory, "signature.hex"),
    body: join(directory, "body.bin"),
  };
  try {
    await Promise.all([
      writeFile(paths.envelope, candidate.envelope, { mode: 0o600 }),
      writeFile(paths.signature, `${candidate.signature}\n`, {
        encoding: "utf8",
        mode: 0o600,
      }),
      writeFile(paths.body, candidate.body, { mode: 0o600 }),
    ]);
    return await action(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function stagedEnvelope<T>(
  envelope: Uint8Array,
  action: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "organum-code-hub-envelope-"));
  await chmod(directory, 0o700);
  const path = join(directory, "envelope.json");
  try {
    await writeFile(path, envelope, { mode: 0o600 });
    return await action(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class OrganumHubCliAuthority implements SignedHubAuthority {
  private readonly hubDirectory: string;
  private readonly binary: string;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxStdoutBytes: number;
  private readonly maxStderrBytes: number;
  private readonly executor: OrganumCommandExecutor;

  constructor(options: OrganumHubCliOptions) {
    if (
      options.hubDirectory.trim().length === 0 ||
      options.hubDirectory.includes("\0") ||
      !isAbsolute(options.hubDirectory)
    ) {
      throw new OrganumCommandError(
        "Signed organum-hub directory must be an absolute path",
        "contract",
      );
    }
    const binary = options.binary?.trim() || "organum-hub";
    if (binary.includes("\0") || Buffer.byteLength(binary, "utf8") > 4096) {
      throw new OrganumCommandError(
        "Signed organum-hub binary is invalid",
        "contract",
      );
    }
    this.hubDirectory = resolve(options.hubDirectory);
    this.binary = binary;
    this.cwd = options.cwd ?? process.cwd();
    this.env = buildOrganumCliEnvironment(options.env ?? process.env);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_STDOUT_LIMIT;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STDERR_LIMIT;
    this.executor = options.executor ?? executeOrganumCommand;
  }

  async verify(candidate: SignedHubCandidate): Promise<SignedHubVerification> {
    return await stagedCandidate(candidate, async (paths) => {
      const value = record(
        await this.json([
          "verify-envelope",
          "--envelope",
          paths.envelope,
          "--sig-file",
          paths.signature,
          "--pubkey",
          candidate.publicKey,
          "--body",
          paths.body,
        ]),
        "verify-envelope",
      );
      const eventID = hex64Field(value, "event_id", "verify-envelope");
      return {
        validSignature: booleanField(
          value,
          "valid_signature",
          "verify-envelope",
        ),
        eventID,
        signer: signer(value.signer),
        eventKind: stringField(value, "event_kind", "verify-envelope"),
        target: target(value.target),
        schemaProblems: schemaProblems(value.schema_problems),
        bodySha256Match: nullableBooleanField(
          value,
          "body_sha256_match",
          "verify-envelope",
        ),
        ledgerTouched: booleanField(
          value,
          "ledger_touched",
          "verify-envelope",
        ),
      };
    });
  }

  async admit(candidate: SignedHubCandidate): Promise<SignedHubAdmission> {
    return await stagedCandidate(candidate, async (paths) => {
      const value = record(
        await this.json([
          "admit",
          "--dir",
          this.hubDirectory,
          "--envelope",
          paths.envelope,
          "--sig-file",
          paths.signature,
          "--pubkey",
          candidate.publicKey,
        ]),
        "admit",
      );
      return {
        admitted: booleanField(value, "admitted", "admit"),
        duplicate: booleanField(value, "duplicate", "admit"),
        eventID: hex64Field(value, "event_id", "admit"),
        acceptedSeq: positiveIntegerField(value, "accepted_seq", "admit"),
        authorityProjected: booleanField(
          value,
          "authority_projected",
          "admit",
        ),
      };
    });
  }

  async inspectRuntime(signal?: AbortSignal): Promise<void> {
    await this.run(["verify-envelope", "--help"], signal);
    await this.run(["admit", "--help"], signal);
    await this.run(["sign", "--help"], signal);
  }

  async replay(signal?: AbortSignal): Promise<void> {
    await this.run(["list", "--dir", this.hubDirectory], signal);
  }

  async signEnvelope(
    envelope: Uint8Array,
    keyFile: string,
  ): Promise<{ signature: string; publicKey: string }> {
    const canonicalKeyFile = await privateKeyFile(keyFile);
    return await stagedEnvelope(envelope, async (path) => {
      const value = record(
        await this.json(
          ["sign", "--key", canonicalKeyFile, "--envelope", path],
          [canonicalKeyFile],
        ),
        "sign",
      );
      const signature = stringField(value, "sig", "sign");
      if (!HEX_128.test(signature)) {
        throw new OrganumCommandError(
          "organum-hub sign.sig must be lowercase hex128",
          "contract",
        );
      }
      return {
        signature,
        publicKey: hex64Field(value, "pubkey", "sign"),
      };
    });
  }

  private async run(
    args: readonly string[],
    signal?: AbortSignal,
    redactions: readonly string[] = [],
  ): Promise<OrganumCommandResult> {
    return await this.executor({
      binary: this.binary,
      args,
      cwd: this.cwd,
      env: this.env,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: this.maxStdoutBytes,
      maxStderrBytes: this.maxStderrBytes,
      signal,
      redactions,
    });
  }

  private async json(
    args: readonly string[],
    redactions: readonly string[] = [],
  ): Promise<unknown> {
    const result = await this.run(args, undefined, redactions);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new OrganumCommandError(
        "organum-hub returned invalid JSON",
        "invalid_json",
      );
    }
  }
}

async function privateKeyFile(path: string): Promise<string> {
  if (
    path.trim().length === 0 ||
    path.includes("\0") ||
    !isAbsolute(path) ||
    Buffer.byteLength(path, "utf8") > 4096
  ) {
    throw new OrganumCommandError(
      "organum-hub signing key must be an absolute path",
      "contract",
    );
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new OrganumCommandError(
      "organum-hub signing key must be a regular non-symlink file",
      "contract",
    );
  }
  return await realpath(path);
}

function ackString(value: string, field: string): string {
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    throw new OrganumCommandError(
      `semantic ACK ${field} is invalid`,
      "contract",
    );
  }
  return value;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export class OrganumHubSemanticAckSink implements SemanticAckSink {
  private readonly authority: OrganumHubCliAuthority;
  private readonly keyFile: string;
  private readonly signer: string;
  private readonly keyID: string;
  private readonly keyEpoch: number;
  private readonly publicKey: string;
  private readonly machineID: string;

  constructor(options: OrganumHubSemanticAckOptions) {
    this.authority = new OrganumHubCliAuthority(options);
    this.keyFile = options.keyFile;
    this.signer = ackString(options.signer, "signer");
    this.keyID = ackString(options.keyID, "key ID");
    if (!Number.isSafeInteger(options.keyEpoch) || options.keyEpoch < 1) {
      throw new OrganumCommandError(
        "semantic ACK key epoch must be a positive safe integer",
        "contract",
      );
    }
    this.keyEpoch = options.keyEpoch;
    if (!HEX_64.test(options.publicKey)) {
      throw new OrganumCommandError(
        "semantic ACK public key must be lowercase hex64",
        "contract",
      );
    }
    this.publicKey = options.publicKey;
    this.machineID = ackString(options.machineID, "machine ID");
  }

  async preflight(): Promise<void> {
    const payload = {
      event_id: "0".repeat(64),
      payload_sha256: "0".repeat(64),
      target_cell: "operator-preflight",
      target_epoch: 1,
      outcome: "deferred",
    };
    const subject = {
      type: "message",
      id: `message:ack-${payload.event_id}`,
    };
    const envelope = canonicalHubJSONBytes({
      envelope_schema: "organum-hub/envelope/v0.2",
      event_kind: "delivery.semantic_ack",
      signer: {
        id: this.signer,
        key_id: this.keyID,
        key_epoch: this.keyEpoch,
      },
      subject,
      provenance: {
        lab: this.signer,
        machine: this.machineID,
        platform: process.platform,
        adapter: "organum-code/signed-hub-supervisor-v1",
        cli_version: null,
        capture: null,
      },
      idempotency_key: digest(
        canonicalHubJSONBytes({
          kind: "delivery.semantic_ack",
          subject,
          payload,
        }),
      ).slice(0, 32),
      created_at: "1970-01-01T00:00:00.000Z",
      payload,
    });
    const signed = await this.authority.signEnvelope(envelope, this.keyFile);
    if (signed.publicKey !== this.publicKey) {
      throw new OrganumCommandError(
        "semantic ACK signing key does not match the configured public key",
        "contract",
      );
    }
  }

  async emit(request: SemanticAckRequest): Promise<SemanticAckReceipt> {
    if (!HEX_64.test(request.eventID) || !HEX_64.test(request.payloadSha256)) {
      throw new OrganumCommandError(
        "semantic ACK source identities must be lowercase hex64",
        "contract",
      );
    }
    const targetCell = ackString(request.targetCell, "target cell");
    if (!Number.isSafeInteger(request.targetEpoch) || request.targetEpoch < 1) {
      throw new OrganumCommandError(
        "semantic ACK target epoch must be a positive safe integer",
        "contract",
      );
    }
    if (
      request.outcome !== "applied" &&
      request.outcome !== "deferred" &&
      request.outcome !== "rejected"
    ) {
      throw new OrganumCommandError(
        "semantic ACK outcome is outside the Hub enum",
        "contract",
      );
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
        request.createdAt,
      ) ||
      !Number.isFinite(Date.parse(request.createdAt))
    ) {
      throw new OrganumCommandError(
        "semantic ACK createdAt must be a supervisor RFC3339 UTC timestamp",
        "contract",
      );
    }
    const payload = {
      event_id: request.eventID,
      payload_sha256: request.payloadSha256,
      target_cell: targetCell,
      target_epoch: request.targetEpoch,
      outcome: request.outcome,
    };
    const subject = {
      type: "message",
      id: `message:ack-${request.eventID}`,
    };
    const idempotencyKey = digest(
      canonicalHubJSONBytes({
        kind: "delivery.semantic_ack",
        subject,
        payload,
      }),
    ).slice(0, 32);
    const envelope = canonicalHubJSONBytes({
      envelope_schema: "organum-hub/envelope/v0.2",
      event_kind: "delivery.semantic_ack",
      signer: {
        id: this.signer,
        key_id: this.keyID,
        key_epoch: this.keyEpoch,
      },
      subject,
      provenance: {
        lab: this.signer,
        machine: this.machineID,
        platform: process.platform,
        adapter: "organum-code/signed-hub-supervisor-v1",
        cli_version: null,
        capture: null,
      },
      idempotency_key: idempotencyKey,
      created_at: request.createdAt,
      payload,
    });
    const signed = await this.authority.signEnvelope(envelope, this.keyFile);
    if (signed.publicKey !== this.publicKey) {
      throw new OrganumCommandError(
        "semantic ACK signing key does not match the configured public key",
        "contract",
      );
    }
    const admission = await this.authority.admit({
      envelope,
      signature: signed.signature,
      publicKey: signed.publicKey,
      body: Buffer.alloc(0),
    });
    if (!admission.admitted) {
      throw new OrganumCommandError(
        "semantic ACK was not admitted by the local Hub",
        "contract",
      );
    }
    return {
      eventID: admission.eventID,
      acceptedSeq: admission.acceptedSeq,
      duplicate: admission.duplicate,
    };
  }
}
