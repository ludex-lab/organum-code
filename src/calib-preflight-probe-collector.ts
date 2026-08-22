import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign,
  verify,
} from "node:crypto";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export const CALIB_PROBE_RECEIPT_SCHEMA =
  "organism-bench/calib-probe-receipt/v2" as const;
export const CALIB_PREFLIGHT_COLLECTOR_PIN =
  "organum-bench/preflight-collector/v1" as const;
export const CALIB_PREFLIGHT_COLLECTOR_AUTHORITY_SCHEMA =
  "organum-code/calib-preflight-collector-authority/v1" as const;
export const CALIB_PROBE_CHAIN_ROOT = "0".repeat(64);
export const CALIB_PREFLIGHT_MAX_REQUESTS_PER_CANDIDATE = 10;

export const CALIB_PROBE_CELLS = [
  "tool_e2e",
  "malformed_boundary",
  "quota_smoke",
  "auth_smoke",
  "data_use_check",
] as const;

export type CalibProbeCell = (typeof CALIB_PROBE_CELLS)[number];

export interface CalibProbeCandidate {
  provider: string;
  modelID: string;
  revision: string;
}

export interface CalibProbeObservation {
  cell: CalibProbeCell;
  requestOrdinal: number;
  requestCount: number;
  requestBytes: Uint8Array;
  responseBytes: Uint8Array;
  accountingReceiptBytes: Uint8Array;
  httpStatus: number;
  rateLimited: boolean;
  recordedAt: string;
}

export interface CalibProbeReceiptBody {
  schema: typeof CALIB_PROBE_RECEIPT_SCHEMA;
  registry_raw_sha256: string;
  provider: string;
  model_id: string;
  revision: string;
  cell: CalibProbeCell;
  run_id: string;
  session_id: string;
  collector_pin: typeof CALIB_PREFLIGHT_COLLECTOR_PIN;
  request_ordinal: number;
  request_count: number;
  request_digest: string;
  response_digest: string;
  http_status: number;
  rate_limited: boolean;
  accounting_receipt_sha256: string;
  binds_prev: string;
  recorded_at: string;
}

export interface CalibProbeReceiptEnvelope {
  body: CalibProbeReceiptBody;
  signature_ed25519: string;
}

export interface EmittedCalibProbeReceipt {
  envelope: CalibProbeReceiptEnvelope;
  raw: Buffer;
  rawSha256: string;
}

export interface CalibPreflightCollectorAuthority {
  schema: typeof CALIB_PREFLIGHT_COLLECTOR_AUTHORITY_SCHEMA;
  collector_pin: typeof CALIB_PREFLIGHT_COLLECTOR_PIN;
  algorithm: "Ed25519";
  public_key_hex: string;
  public_key_sha256: string;
  private_key_storage: "operator-controlled-outside-repo";
  provisioned_at: string;
}

export interface VerifyCalibProbeReceiptOptions {
  publicKeyHex: string;
  previousRawSha256?: string;
  registryRawSha256?: string;
  candidate?: CalibProbeCandidate;
  cell?: CalibProbeCell;
}

export interface VerifiedCalibProbeReceipt {
  envelope: CalibProbeReceiptEnvelope;
  rawSha256: string;
}

export class CalibPreflightCollectorError extends Error {
  override readonly name = "CalibPreflightCollectorError";
}

const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_128 = /^[0-9a-f]{128}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const RECEIPT_ENVELOPE_KEYS = ["body", "signature_ed25519"] as const;
const RECEIPT_BODY_KEYS = [
  "accounting_receipt_sha256",
  "binds_prev",
  "cell",
  "collector_pin",
  "http_status",
  "model_id",
  "provider",
  "rate_limited",
  "recorded_at",
  "registry_raw_sha256",
  "request_count",
  "request_digest",
  "request_ordinal",
  "response_digest",
  "revision",
  "run_id",
  "schema",
  "session_id",
] as const;

type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function assertNoUnpairedSurrogate(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CalibPreflightCollectorError(
          "canonical JSON strings must not contain an unpaired surrogate",
        );
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CalibPreflightCollectorError(
        "canonical JSON strings must not contain an unpaired surrogate",
      );
    }
  }
}

function normalizeCanonicalValue(value: unknown): CanonicalValue {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    assertNoUnpairedSurrogate(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CalibPreflightCollectorError(
        "canonical receipt JSON only accepts safe integers",
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCanonicalValue(entry));
  }
  if (typeof value !== "object" || value === undefined) {
    throw new CalibPreflightCollectorError(
      "canonical receipt JSON contains an unsupported value",
    );
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CalibPreflightCollectorError(
      "canonical receipt JSON only accepts plain objects",
    );
  }
  const normalized: Record<string, CanonicalValue> = {};
  for (const key of Object.keys(value).sort()) {
    assertNoUnpairedSurrogate(key);
    normalized[key] = normalizeCanonicalValue(
      (value as Record<string, unknown>)[key],
    );
  }
  return normalized;
}

export function canonicalCalibJsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(normalizeCanonicalValue(value)), "utf8");
}

export function calibSha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new CalibPreflightCollectorError(`${label} has an invalid key set`);
  }
}

function assertHex64(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw new CalibPreflightCollectorError(`${label} must be lowercase hex64`);
  }
}

function assertSafeID(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !SAFE_ID.test(value) ||
    value.includes("..")
  ) {
    throw new CalibPreflightCollectorError(`${label} has an invalid ID grammar`);
  }
}

function assertRunID(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !SAFE_RUN_ID.test(value) ||
    value.includes("..")
  ) {
    throw new CalibPreflightCollectorError(`${label} has an invalid ID grammar`);
  }
}

function normalizePrivateKey(privateKey: KeyObject | string | Buffer): KeyObject {
  const key = privateKey instanceof KeyObject
    ? privateKey
    : createPrivateKey(privateKey);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new CalibPreflightCollectorError(
      "collector private key must be an Ed25519 private key",
    );
  }
  return key;
}

function publicKeyFromRawHex(publicKeyHex: string): KeyObject {
  if (!HEX_64.test(publicKeyHex)) {
    throw new CalibPreflightCollectorError(
      "collector public key must be lowercase raw Ed25519 hex64",
    );
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
    format: "der",
    type: "spki",
  });
}

export function rawEd25519PublicKeyHex(
  privateOrPublicKey: KeyObject | string | Buffer,
): string {
  const key = privateOrPublicKey instanceof KeyObject
    ? privateOrPublicKey
    : createPrivateKey(privateOrPublicKey);
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new CalibPreflightCollectorError("collector key must be Ed25519");
  }
  const spki = publicKey.export({ format: "der", type: "spki" });
  if (
    spki.length !== ED25519_SPKI_PREFIX.length + 32 ||
    !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new CalibPreflightCollectorError(
      "unexpected Ed25519 SubjectPublicKeyInfo encoding",
    );
  }
  return spki.subarray(ED25519_SPKI_PREFIX.length).toString("hex");
}

function parseEnvelope(raw: Uint8Array): CalibProbeReceiptEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new CalibPreflightCollectorError("probe receipt is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CalibPreflightCollectorError("probe receipt envelope must be an object");
  }
  assertExactKeys(
    parsed as Record<string, unknown>,
    RECEIPT_ENVELOPE_KEYS,
    "probe receipt envelope",
  );
  const body = (parsed as Record<string, unknown>).body;
  const signature = (parsed as Record<string, unknown>).signature_ed25519;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CalibPreflightCollectorError("probe receipt body must be an object");
  }
  assertExactKeys(
    body as Record<string, unknown>,
    RECEIPT_BODY_KEYS,
    "probe receipt body",
  );
  if (typeof signature !== "string" || !HEX_128.test(signature)) {
    throw new CalibPreflightCollectorError(
      "probe receipt signature must be lowercase Ed25519 hex128",
    );
  }
  return {
    body: body as unknown as CalibProbeReceiptBody,
    signature_ed25519: signature,
  };
}

function validateReceiptBody(body: CalibProbeReceiptBody): void {
  if (body.schema !== CALIB_PROBE_RECEIPT_SCHEMA) {
    throw new CalibPreflightCollectorError("probe receipt schema mismatch");
  }
  if (body.collector_pin !== CALIB_PREFLIGHT_COLLECTOR_PIN) {
    throw new CalibPreflightCollectorError("probe receipt collector pin mismatch");
  }
  assertHex64(body.registry_raw_sha256, "registry_raw_sha256");
  assertHex64(body.request_digest, "request_digest");
  assertHex64(body.response_digest, "response_digest");
  assertHex64(body.accounting_receipt_sha256, "accounting_receipt_sha256");
  assertHex64(body.binds_prev, "binds_prev");
  assertSafeID(body.provider, "provider");
  assertSafeID(body.model_id, "model_id");
  assertSafeID(body.revision, "revision");
  assertRunID(body.run_id, "run_id");
  assertRunID(body.session_id, "session_id");
  if (!(CALIB_PROBE_CELLS as readonly string[]).includes(body.cell)) {
    throw new CalibPreflightCollectorError("probe receipt cell is unknown");
  }
  if (
    !Number.isInteger(body.request_count) ||
    body.request_count < 1 ||
    body.request_count > 24 ||
    !Number.isInteger(body.request_ordinal) ||
    body.request_ordinal < 1 ||
    body.request_ordinal > body.request_count
  ) {
    throw new CalibPreflightCollectorError("probe receipt request lineage is invalid");
  }
  if (
    !Number.isInteger(body.http_status) ||
    body.http_status < 100 ||
    body.http_status > 599
  ) {
    throw new CalibPreflightCollectorError("probe receipt HTTP status is invalid");
  }
  if (typeof body.rate_limited !== "boolean") {
    throw new CalibPreflightCollectorError("probe receipt rate_limited must be boolean");
  }
  if (!RFC3339.test(body.recorded_at)) {
    throw new CalibPreflightCollectorError("probe receipt recorded_at must be UTC RFC3339");
  }
}

export function verifyCalibProbeReceipt(
  raw: Uint8Array,
  options: VerifyCalibProbeReceiptOptions,
): VerifiedCalibProbeReceipt {
  const envelope = parseEnvelope(raw);
  validateReceiptBody(envelope.body);
  const publicKey = publicKeyFromRawHex(options.publicKeyHex);
  const valid = verify(
    null,
    canonicalCalibJsonBytes(envelope.body),
    publicKey,
    Buffer.from(envelope.signature_ed25519, "hex"),
  );
  if (!valid) {
    throw new CalibPreflightCollectorError("probe receipt signature is invalid");
  }
  if (
    options.previousRawSha256 !== undefined &&
    envelope.body.binds_prev !== options.previousRawSha256
  ) {
    throw new CalibPreflightCollectorError("probe receipt append-only chain mismatch");
  }
  if (
    options.registryRawSha256 !== undefined &&
    envelope.body.registry_raw_sha256 !== options.registryRawSha256
  ) {
    throw new CalibPreflightCollectorError("probe receipt registry binding mismatch");
  }
  if (
    options.candidate !== undefined &&
    (envelope.body.provider !== options.candidate.provider ||
      envelope.body.model_id !== options.candidate.modelID ||
      envelope.body.revision !== options.candidate.revision)
  ) {
    throw new CalibPreflightCollectorError("probe receipt candidate binding mismatch");
  }
  if (options.cell !== undefined && envelope.body.cell !== options.cell) {
    throw new CalibPreflightCollectorError("probe receipt cell binding mismatch");
  }
  return {
    envelope,
    rawSha256: calibSha256(raw),
  };
}

export class CalibPreflightProbeCollector {
  readonly #registryRawSha256: string;
  readonly #candidate: CalibProbeCandidate;
  readonly #runID: string;
  readonly #sessionID: string;
  readonly #privateKey: KeyObject;
  #previousRawSha256 = CALIB_PROBE_CHAIN_ROOT;

  constructor(options: {
    registryRawSha256: string;
    candidate: CalibProbeCandidate;
    runID: string;
    sessionID: string;
    privateKey: KeyObject | string | Buffer;
  }) {
    assertHex64(options.registryRawSha256, "registryRawSha256");
    assertSafeID(options.candidate.provider, "candidate.provider");
    assertSafeID(options.candidate.modelID, "candidate.modelID");
    assertSafeID(options.candidate.revision, "candidate.revision");
    assertRunID(options.runID, "runID");
    assertRunID(options.sessionID, "sessionID");
    this.#registryRawSha256 = options.registryRawSha256;
    this.#candidate = { ...options.candidate };
    this.#runID = options.runID;
    this.#sessionID = options.sessionID;
    this.#privateKey = normalizePrivateKey(options.privateKey);
  }

  get publicKeyHex(): string {
    return rawEd25519PublicKeyHex(this.#privateKey);
  }

  get previousRawSha256(): string {
    return this.#previousRawSha256;
  }

  record(observation: CalibProbeObservation): EmittedCalibProbeReceipt {
    if (!(CALIB_PROBE_CELLS as readonly string[]).includes(observation.cell)) {
      throw new CalibPreflightCollectorError("probe observation cell is unknown");
    }
    if (
      !Number.isInteger(observation.requestCount) ||
      observation.requestCount < 1 ||
      observation.requestCount > CALIB_PREFLIGHT_MAX_REQUESTS_PER_CANDIDATE ||
      !Number.isInteger(observation.requestOrdinal) ||
      observation.requestOrdinal < 1 ||
      observation.requestOrdinal > observation.requestCount
    ) {
      throw new CalibPreflightCollectorError(
        `probe request lineage must stay within the JJ_GO cap of ${CALIB_PREFLIGHT_MAX_REQUESTS_PER_CANDIDATE}`,
      );
    }
    if (
      !Number.isInteger(observation.httpStatus) ||
      observation.httpStatus < 100 ||
      observation.httpStatus > 599
    ) {
      throw new CalibPreflightCollectorError("probe HTTP status must be 100..599");
    }
    if (typeof observation.rateLimited !== "boolean") {
      throw new CalibPreflightCollectorError("probe rateLimited must be boolean");
    }
    if (!RFC3339.test(observation.recordedAt)) {
      throw new CalibPreflightCollectorError(
        "probe recordedAt must be a UTC RFC3339 timestamp",
      );
    }
    for (const [label, bytes] of [
      ["requestBytes", observation.requestBytes],
      ["responseBytes", observation.responseBytes],
      ["accountingReceiptBytes", observation.accountingReceiptBytes],
    ] as const) {
      if (!(bytes instanceof Uint8Array)) {
        throw new CalibPreflightCollectorError(`${label} must be raw bytes`);
      }
    }

    const body: CalibProbeReceiptBody = {
      schema: CALIB_PROBE_RECEIPT_SCHEMA,
      registry_raw_sha256: this.#registryRawSha256,
      provider: this.#candidate.provider,
      model_id: this.#candidate.modelID,
      revision: this.#candidate.revision,
      cell: observation.cell,
      run_id: this.#runID,
      session_id: this.#sessionID,
      collector_pin: CALIB_PREFLIGHT_COLLECTOR_PIN,
      request_ordinal: observation.requestOrdinal,
      request_count: observation.requestCount,
      request_digest: calibSha256(observation.requestBytes),
      response_digest: calibSha256(observation.responseBytes),
      http_status: observation.httpStatus,
      rate_limited: observation.rateLimited,
      accounting_receipt_sha256: calibSha256(
        observation.accountingReceiptBytes,
      ),
      binds_prev: this.#previousRawSha256,
      recorded_at: observation.recordedAt,
    };
    const signature = sign(
      null,
      canonicalCalibJsonBytes(body),
      this.#privateKey,
    );
    const envelope: CalibProbeReceiptEnvelope = {
      body,
      signature_ed25519: signature.toString("hex"),
    };
    const raw = canonicalCalibJsonBytes(envelope);
    const rawSha256 = calibSha256(raw);
    this.#previousRawSha256 = rawSha256;
    return {
      envelope,
      raw,
      rawSha256,
    };
  }
}

export async function loadCalibPreflightCollectorPrivateKey(
  privateKeyPath: string,
): Promise<KeyObject> {
  if (!isAbsolute(privateKeyPath)) {
    throw new CalibPreflightCollectorError(
      "collector private key path must be absolute",
    );
  }
  const resolved = resolve(privateKeyPath);
  const metadata = await lstat(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new CalibPreflightCollectorError(
      "collector private key must be a regular non-symlink file",
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new CalibPreflightCollectorError(
      "collector private key permissions must exclude group and other access",
    );
  }
  return normalizePrivateKey(await readFile(resolved));
}

export async function provisionCalibPreflightCollectorKey(options: {
  privateKeyPath: string;
  provisionedAt: string;
}): Promise<CalibPreflightCollectorAuthority> {
  if (!isAbsolute(options.privateKeyPath)) {
    throw new CalibPreflightCollectorError(
      "collector private key path must be absolute",
    );
  }
  if (!RFC3339.test(options.provisionedAt)) {
    throw new CalibPreflightCollectorError(
      "provisionedAt must be a UTC RFC3339 timestamp",
    );
  }
  const privateKeyPath = resolve(options.privateKeyPath);
  await mkdir(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  const handle = await open(privateKeyPath, "wx", 0o600);
  try {
    await handle.writeFile(pem);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const publicKeyHex = rawEd25519PublicKeyHex(privateKey);
  return {
    schema: CALIB_PREFLIGHT_COLLECTOR_AUTHORITY_SCHEMA,
    collector_pin: CALIB_PREFLIGHT_COLLECTOR_PIN,
    algorithm: "Ed25519",
    public_key_hex: publicKeyHex,
    public_key_sha256: calibSha256(Buffer.from(publicKeyHex, "hex")),
    private_key_storage: "operator-controlled-outside-repo",
    provisioned_at: options.provisionedAt,
  };
}
