import { createHash } from "node:crypto";

export const SJC1_RECEIPT_SCHEMA =
  "organum-code/seam-joint-containment-receipt/v1" as const;
export const SJC1_CANONICAL_MAX_DEPTH = 128;
export const SJC1_MAX_SAFE_INTEGER = 2 ** 53 - 1;

export const SJC1_LANES = ["core", "sqlite"] as const;
export type SJC1Lane = (typeof SJC1_LANES)[number];

export const SJC1_PROBE_TARGETS = {
  runner_board_rw: {
    read: "runner-board-relative",
    write: "runner-board-relative",
  },
  peer_absolute_read: { read: "peer-view-absolute" },
  pack_git_absolute_read: {
    pack: "pack-absolute",
    git: "repo-git-absolute",
  },
  inherited_fd_read: { read: "inherited-host-fd" },
  direct_board_write: { write: "runner-board-direct" },
  actor_runner_control: { call: "runner-control-api" },
} as const;

export const SJC1_CHAIN_ORDER = [
  "containment_start",
  "actor_turns",
  "canonical_close",
  "merge_plan_commitment",
  "runner_actual_apply",
] as const;

export type SJC1ChainStageName = (typeof SJC1_CHAIN_ORDER)[number];
export type SJC1JSONValue =
  | null
  | boolean
  | number
  | string
  | SJC1JSONValue[]
  | { [key: string]: SJC1JSONValue };

export class SeamJointReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeamJointReceiptError";
  }
}

function fail(message: string): never {
  throw new SeamJointReceiptError(message);
}

function validateUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        fail("SJC1 strings must not contain lone surrogates");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail("SJC1 strings must not contain lone surrogates");
    }
  }
}

function canonicalText(value: unknown, depth: number): string {
  if (depth > SJC1_CANONICAL_MAX_DEPTH) {
    fail(`SJC1 canonical JSON exceeds depth ${SJC1_CANONICAL_MAX_DEPTH}`);
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Math.abs(value) > SJC1_MAX_SAFE_INTEGER) {
      fail("SJC1 canonical JSON numbers must be safe integers");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    validateUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const allowed = new Set([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    if (
      Reflect.ownKeys(value).some((key) => typeof key === "symbol") ||
      Object.getOwnPropertyNames(value).some((key) => !allowed.has(key))
    ) {
      fail("SJC1 canonical arrays must not contain named or symbol properties");
    }
    const values: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        fail("SJC1 canonical arrays must not contain holes");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        fail("SJC1 canonical arrays must contain enumerable data values");
      }
      values.push(canonicalText(descriptor.value, depth + 1));
    }
    return `[${values.join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("SJC1 canonical objects must have a plain or null prototype");
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
      fail("SJC1 canonical objects must not contain symbol keys");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const fields: string[] = [];
    for (const key of keys) {
      if (
        key.length === 0 ||
        [...key].some((character) => {
          const code = character.codePointAt(0)!;
          return code < 0x20 || code > 0x7e;
        })
      ) {
        fail("SJC1 canonical object keys must be nonempty printable ASCII");
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        fail("SJC1 canonical objects must contain enumerable data properties only");
      }
      fields.push(
        `${JSON.stringify(key)}:${canonicalText(descriptor.value, depth + 1)}`,
      );
    }
    return `{${fields.join(",")}}`;
  }
  fail(`Unsupported SJC1 canonical JSON type: ${typeof value}`);
}

export function canonicalizeSJC1(value: unknown): Buffer {
  return Buffer.from(canonicalText(value, 0), "utf8");
}

export function sha256SJC1(value: unknown): string {
  return createHash("sha256").update(canonicalizeSJC1(value)).digest("hex");
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertHex64(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`${context} must be lowercase hex64`);
  }
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalizeSJC1(value).toString("utf8")) as T;
}

export interface SJC1ProbeLeaf {
  attempted: true;
  blocked: true;
  target: string;
  evidence_sha256: string;
}

export type SJC1NegativeProbes = Record<
  SJC1Lane,
  Record<string, Record<string, SJC1ProbeLeaf>>
>;

export interface SJC1ActualApply {
  input_lane_patch_sha256: Record<SJC1Lane, string>;
  decision_digest: string;
  conflict: false;
  apply_status: "applied";
  parent_tree_sha256: string;
  output_sha256: string;
}

export interface SJC1ReceiptInput {
  cell: string;
  backend: Record<SJC1Lane, string>;
  benchPin: string;
  organumCodePin: string;
  containmentPolicySha256: string;
  laneViewSha256: Record<SJC1Lane, string>;
  startReceiptSha256: Record<SJC1Lane, string>;
  negativeProbes: SJC1NegativeProbes;
  turnTranscriptSha256: string;
  providerCalls: 0;
  closeReceiptSha256: string;
  mergePlanCommitment: Record<string, SJC1JSONValue>;
  actualApply: SJC1ActualApply;
}

export interface SJC1ChainStage {
  stage: SJC1ChainStageName;
  sha256: string;
  binds_prev: string;
  payload: Record<string, SJC1JSONValue>;
}

export interface SJC1Receipt {
  schema: typeof SJC1_RECEIPT_SCHEMA;
  cell: string;
  lanes: SJC1Lane[];
  platform: "darwin";
  backend: Record<SJC1Lane, string>;
  bench_pin: string;
  organum_code_pin: string;
  containment_policy_sha256: string;
  lane_view_sha256: Record<SJC1Lane, string>;
  start_receipt_sha256: Record<SJC1Lane, string>;
  negative_probes: SJC1NegativeProbes;
  provider_calls: 0;
  close_receipt_sha256: string;
  merge_plan_commitment_sha256: string;
  actual_apply: SJC1ActualApply;
  chain: SJC1ChainStage[];
}

export function sjc1StageSha256(
  stage: SJC1ChainStageName,
  bindsPrev: string,
  payload: Record<string, SJC1JSONValue>,
): string {
  return sha256SJC1({ stage, binds_prev: bindsPrev, payload });
}

function validateProbeShape(probes: SJC1NegativeProbes): void {
  if (
    Object.keys(probes).sort().join(",") !== [...SJC1_LANES].sort().join(",")
  ) {
    fail("SJC1 negative probes must contain the exact core/sqlite lane set");
  }
  for (const lane of SJC1_LANES) {
    const actualProbes = probes[lane];
    if (
      Object.keys(actualProbes).sort().join(",") !==
      Object.keys(SJC1_PROBE_TARGETS).sort().join(",")
    ) {
      fail(`SJC1 ${lane} probe set is not exact`);
    }
    for (const [probe, targets] of Object.entries(SJC1_PROBE_TARGETS)) {
      const operations = actualProbes[probe];
      if (
        Object.keys(operations).sort().join(",") !==
        Object.keys(targets).sort().join(",")
      ) {
        fail(`SJC1 ${lane}.${probe} operation set is not exact`);
      }
      for (const [operation, target] of Object.entries(targets)) {
        const leaf = operations[operation];
        if (
          leaf.attempted !== true ||
          leaf.blocked !== true ||
          leaf.target !== target
        ) {
          fail(`SJC1 ${lane}.${probe}.${operation} is not an exact blocked attempt`);
        }
        assertHex64(
          leaf.evidence_sha256,
          `SJC1 ${lane}.${probe}.${operation}.evidence_sha256`,
        );
      }
    }
  }
}

export function createSJC1Receipt(input: SJC1ReceiptInput): SJC1Receipt {
  if (input.cell.length === 0 || input.benchPin.length === 0 || input.organumCodePin.length === 0) {
    fail("SJC1 identity fields must be nonempty");
  }
  for (const [context, value] of [
    ["containmentPolicySha256", input.containmentPolicySha256],
    ["turnTranscriptSha256", input.turnTranscriptSha256],
    ["closeReceiptSha256", input.closeReceiptSha256],
  ] as const) {
    assertHex64(value, context);
  }
  for (const lane of SJC1_LANES) {
    assertHex64(input.laneViewSha256[lane], `${lane} lane view SHA`);
    assertHex64(input.startReceiptSha256[lane], `${lane} start receipt SHA`);
    assertHex64(
      input.actualApply.input_lane_patch_sha256[lane],
      `${lane} actual-apply patch SHA`,
    );
  }
  assertHex64(input.actualApply.decision_digest, "actual-apply decision digest");
  assertHex64(input.actualApply.parent_tree_sha256, "actual-apply parent tree SHA");
  assertHex64(input.actualApply.output_sha256, "actual-apply output SHA");
  validateProbeShape(input.negativeProbes);
  if (input.providerCalls !== 0) fail("SJC1 provider calls must be exactly zero");

  const commitment = cloneCanonical(input.mergePlanCommitment);
  const inputPatchSha = commitment.input_lane_patch_sha;
  if (
    inputPatchSha === null ||
    typeof inputPatchSha !== "object" ||
    Array.isArray(inputPatchSha) ||
    (inputPatchSha as Record<string, unknown>).core !==
      input.actualApply.input_lane_patch_sha256.core ||
    (inputPatchSha as Record<string, unknown>).sqlite !==
      input.actualApply.input_lane_patch_sha256.sqlite
  ) {
    fail("SJC1 actual-apply patch SHAs must equal the commitment object");
  }
  if (commitment.decision_digest !== input.actualApply.decision_digest) {
    fail("SJC1 actual-apply decision digest must equal the commitment object");
  }

  const mergePlanCommitmentSha256 = sha256SJC1(commitment);
  const probes = cloneCanonical(input.negativeProbes);
  const actualApply = cloneCanonical(input.actualApply);
  const payloads: Record<SJC1ChainStageName, Record<string, SJC1JSONValue>> = {
    containment_start: {
      cell: input.cell,
      lanes: [...SJC1_LANES],
      platform: "darwin",
      backend: cloneCanonical(input.backend),
      bench_pin: input.benchPin,
      organum_code_pin: input.organumCodePin,
      containment_policy_sha256: input.containmentPolicySha256,
      lane_view_sha256: cloneCanonical(input.laneViewSha256),
      start_receipt_sha256: cloneCanonical(input.startReceiptSha256),
    },
    actor_turns: {
      negative_probes: probes as unknown as SJC1JSONValue,
      provider_calls: 0,
      turn_transcript_sha256: input.turnTranscriptSha256,
    },
    canonical_close: { close_receipt_sha256: input.closeReceiptSha256 },
    merge_plan_commitment: {
      merge_plan_commitment_sha256: mergePlanCommitmentSha256,
    },
    runner_actual_apply: {
      actual_apply: actualApply as unknown as SJC1JSONValue,
      merge_plan_commitment_sha256: mergePlanCommitmentSha256,
    },
  };

  const chain: SJC1ChainStage[] = [];
  let previous = input.containmentPolicySha256;
  for (const stage of SJC1_CHAIN_ORDER) {
    const payload = payloads[stage];
    const digest = sjc1StageSha256(stage, previous, payload);
    chain.push({ stage, sha256: digest, binds_prev: previous, payload });
    previous = digest;
  }

  return {
    schema: SJC1_RECEIPT_SCHEMA,
    cell: input.cell,
    lanes: [...SJC1_LANES],
    platform: "darwin",
    backend: cloneCanonical(input.backend),
    bench_pin: input.benchPin,
    organum_code_pin: input.organumCodePin,
    containment_policy_sha256: input.containmentPolicySha256,
    lane_view_sha256: cloneCanonical(input.laneViewSha256),
    start_receipt_sha256: cloneCanonical(input.startReceiptSha256),
    negative_probes: probes,
    provider_calls: 0,
    close_receipt_sha256: input.closeReceiptSha256,
    merge_plan_commitment_sha256: mergePlanCommitmentSha256,
    actual_apply: actualApply,
    chain,
  };
}
