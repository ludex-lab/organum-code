import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { z } from "zod";

import {
  actorWorkspaceFingerprint,
  normalizeActorName,
} from "./actor-runtime.js";
import {
  COORDINATION_CONTEXT_MAX_BYTES,
  type CoordinationSystemPacket,
} from "./coordination-context.js";
import { ConfigurationError } from "./provider-profile.js";
import {
  parsePtyBridgeCompactionTelemetry,
  parsePtyBridgeCompletionReceiptTelemetry,
  prepareMacosPtyBridge,
} from "./pty-bridge.js";
import {
  organismCastHumanInputPaths,
  readOrganismCastHumanInputEvents,
  type OrganismCastHumanInputEvent,
  type OrganismCastHumanInputPaths,
} from "./organism-cast-human-input.js";
import { normalizeUserProfileName } from "./user-config.js";
import {
  FINDING_DELIVERY_LIFECYCLE_SCHEMA,
  FINDING_DELIVERY_RECEIPT_SCHEMA,
  FINDING_DELIVERY_REGISTRATION_SCHEMA,
} from "./finding-delivery.js";

export const ORGANISM_CAST_MANIFEST_SCHEMA_V1 =
  "organum-code/organism-cast-manifest/v1" as const;
export const ORGANISM_CAST_MANIFEST_SCHEMA =
  "organum-code/organism-cast-manifest/v2" as const;
export const ORGANISM_CAST_MANIFEST_SCHEMA_V3 =
  "organum-code/organism-cast-manifest/v3" as const;
export const ORGANISM_CAST_RESULT_SCHEMA =
  "organum-code/organism-cast-result/v2" as const;
export const ORGANISM_CAST_RESULT_SCHEMA_V3 =
  "organum-code/organism-cast-result/v3" as const;
export const ORGANISM_DELIVERY_TELEMETRY_SCHEMA =
  "organum-code/native-coordination-delivery/v1" as const;

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_MISSION_BYTES = 64 * 1024;
const MAX_LANE_OUTPUT_BYTES = 4 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const fileReferenceSchema = z
  .object({
    path: z.string().min(1).max(4_096),
    sha256: z.string().regex(SHA256_PATTERN),
  })
  .strict();

const castLaneSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    profile: z.string().min(1).max(40),
    backend: z.enum(["opencode", "claude", "grok", "deepcode", "codex"]),
    mission: fileReferenceSchema,
  })
  .strict();

const findingDeliveryPinSchema = z
  .object({
    contract: z
      .object({
        registration_schema: z.literal(FINDING_DELIVERY_REGISTRATION_SCHEMA),
        receipt_schema: z.literal(FINDING_DELIVERY_RECEIPT_SCHEMA),
        lifecycle_schema: z.literal(FINDING_DELIVERY_LIFECYCLE_SCHEMA),
      })
      .strict(),
    route: z
      .object({
        channel: z.enum(["organum_coordination", "bare_no_coordination"]),
        route_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
      })
      .strict(),
  })
  .strict();

const castManifestCommonSchema = z
  .object({
    run_id: z.string().regex(ID_PATTERN),
    arm: z.enum(["organum", "bare"]),
    pack: z
      .object({
        id: z.string().regex(ID_PATTERN),
        manifest: fileReferenceSchema,
      })
      .strict(),
    run_directory: z.string().min(1).max(4_096),
    work_directory: z.string().min(1).max(4_096),
    state_directory: z.string().min(1).max(4_096),
    goal: fileReferenceSchema,
    comparison_key: z.string().regex(SHA256_PATTERN),
    preregistration_id: z.string().min(1).max(256),
    delivery_gate: z
      .object({
        telemetry_schema: z.literal(
          ORGANISM_DELIVERY_TELEMETRY_SCHEMA,
        ),
        evaluator: fileReferenceSchema,
      })
      .strict()
      .optional(),
    timeout_ms: z.number().int().min(60_000).max(4 * 60 * 60 * 1_000),
    lanes: z.array(castLaneSchema).min(1).max(16),
  })
  .strict();

const castManifestSchema = z.discriminatedUnion("schema", [
  castManifestCommonSchema.extend({
    schema: z.literal(ORGANISM_CAST_MANIFEST_SCHEMA_V1),
  }),
  castManifestCommonSchema.extend({
    schema: z.literal(ORGANISM_CAST_MANIFEST_SCHEMA),
    preregistration: fileReferenceSchema,
  }),
  castManifestCommonSchema.extend({
    schema: z.literal(ORGANISM_CAST_MANIFEST_SCHEMA_V3),
    preregistration: fileReferenceSchema,
    finding_delivery: findingDeliveryPinSchema,
  }),
]);

const castPreregistrationSchema = z
  .object({
    preregistration_id: z.string().min(1).max(256),
    cast_timeout_ms: z.number().int().min(60_000).max(4 * 60 * 60 * 1_000),
  })
  .passthrough();

const castPreregistrationV3Schema = castPreregistrationSchema.extend({
  finding_delivery: findingDeliveryPinSchema,
});

const packIndexSchema = z
  .object({
    id: z.string().regex(ID_PATTERN),
    lanes: z
      .array(
        z.object({ id: z.string().regex(ID_PATTERN) }).passthrough(),
      )
      .min(1)
      .max(16),
  })
  .passthrough();

export type OrganismCastArm = "organum" | "bare";
export type OrganismCastBackend =
  | "opencode"
  | "claude"
  | "grok"
  | "deepcode"
  | "codex";

export interface OrganismCastLanePlan {
  id: string;
  actor: string;
  profile: string;
  backend: OrganismCastBackend;
  missionSha256: string;
  promptSha256: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
}

export interface OrganismCastPlan {
  schema:
    | typeof ORGANISM_CAST_MANIFEST_SCHEMA
    | typeof ORGANISM_CAST_MANIFEST_SCHEMA_V1
    | typeof ORGANISM_CAST_MANIFEST_SCHEMA_V3;
  manifestPath: string;
  manifestSha256: string;
  runID: string;
  arm: OrganismCastArm;
  packID: string;
  packSha256: string;
  comparisonKey: string;
  preregistrationID: string;
  preregistrationPath: string | null;
  preregistrationSha256: string | null;
  preregisteredTimeoutMs: number | null;
  deliveryGate: OrganismCastDeliveryGate | null;
  findingDelivery: z.infer<typeof findingDeliveryPinSchema> | null;
  runDirectory: string;
  workDirectory: string;
  stateDirectory: string;
  logDirectory: string;
  donePath: string;
  resultPath: string;
  goalSha256: string;
  timeoutMs: number;
  lanes: readonly OrganismCastLanePlan[];
}

export interface OrganismCastDeliveryGate {
  telemetrySchema: typeof ORGANISM_DELIVERY_TELEMETRY_SCHEMA;
  evaluatorPath: string;
  evaluatorSha256: string;
  qualificationCases: readonly string[];
}

export interface OrganismCastLaneExecutionResult {
  id: string;
  actor: string;
  backend: OrganismCastBackend;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  outputExceeded: boolean;
  outputCompacted: boolean | null;
  outputDiscardedBytes: number | null;
  terminated_by_deadline?: boolean;
  completion_receipt_observed?: boolean;
  completion_receipt_status?: "completed" | "failed" | null;
  completion_receipt_at?: string | null;
  human_input_state?: "not_observed" | "answered" | "blocked_on_human_input";
  blocked_at?: string | null;
  question_id?: string | null;
  human_input_answered_at?: string | null;
  human_input_events?: OrganismCastHumanInputEvent[];
}

export interface OrganismCastLaneResult
  extends OrganismCastLaneExecutionResult {
  terminated_by_deadline: boolean;
  completion_receipt_observed: boolean;
  completion_receipt_status: "completed" | "failed" | null;
  completion_receipt_at: string | null;
  human_input_state: "not_observed" | "answered" | "blocked_on_human_input";
  blocked_at: string | null;
  question_id: string | null;
  human_input_answered_at: string | null;
  human_input_events: OrganismCastHumanInputEvent[];
}

export interface OrganismCastExecutor {
  (
    lane: OrganismCastLanePlan,
    plan: OrganismCastPlan,
    signal: AbortSignal,
  ): Promise<OrganismCastLaneExecutionResult>;
}

export interface OrganismCastRunResult {
  schema: typeof ORGANISM_CAST_RESULT_SCHEMA;
  run_id: string;
  arm: OrganismCastArm;
  pack: string;
  manifest_sha256: string;
  comparison_key: string;
  provider_execution_authorized: boolean;
  organum_consume_capability: boolean;
  started_at: string;
  timeout_ms: number;
  deadline_at: string;
  finished_at: string;
  truncated_by_deadline: boolean;
  abort_reason: "deadline_exceeded" | "blocked_on_human_input" | null;
  right_censored_by_deadline: boolean;
  completed: boolean;
  lanes: OrganismCastLaneResult[];
}

export interface OrganismCastCoordinationBinding {
  args: readonly string[];
  basePromptSha256: string;
  coordinationPacketSha256: string;
  effectivePromptSha256: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function bindOrganismCastCoordinationPacket(
  args: readonly string[],
  expectedPromptSha256: string,
  packet: CoordinationSystemPacket,
): OrganismCastCoordinationBinding {
  if (
    !SHA256_PATTERN.test(expectedPromptSha256) ||
    Buffer.byteLength(packet.text, "utf8") > COORDINATION_CONTEXT_MAX_BYTES
  ) {
    throw new ConfigurationError(
      "Organism cast coordination packet binding is invalid",
    );
  }
  const promptIndex = args.length - 1;
  const basePrompt = args[promptIndex];
  if (
    promptIndex < 0 ||
    basePrompt === undefined ||
    sha256(basePrompt) !== expectedPromptSha256
  ) {
    throw new ConfigurationError(
      "Organism cast base prompt does not match its digest-bound manifest",
    );
  }
  const effectivePrompt = [
    packet.text,
    "",
    "<organism-benchmark-mission>",
    basePrompt,
    "</organism-benchmark-mission>",
  ].join("\n");
  return {
    args: [
      ...args.slice(0, promptIndex),
      effectivePrompt,
    ],
    basePromptSha256: expectedPromptSha256,
    coordinationPacketSha256: sha256(packet.text),
    effectivePromptSha256: sha256(effectivePrompt),
  };
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function regularFile(path: string, context: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ConfigurationError(`${context} must be an absolute path`);
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ConfigurationError(
      `${context} must be an existing regular non-symlink file`,
    );
  }
  return await realpath(path);
}

async function existingDirectory(
  path: string,
  context: string,
): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ConfigurationError(`${context} must be an absolute path`);
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ConfigurationError(
      `${context} must be an existing real non-symlink directory`,
    );
  }
  return await realpath(path);
}

async function boundedText(
  path: string,
  expectedDigest: string,
  context: string,
): Promise<{ path: string; text: string }> {
  const canonical = await regularFile(path, context);
  const metadata = await lstat(canonical);
  if (metadata.size > MAX_MISSION_BYTES) {
    throw new ConfigurationError(
      `${context} exceeds ${MAX_MISSION_BYTES} bytes`,
    );
  }
  const body = await readFile(canonical);
  if (sha256(body) !== expectedDigest) {
    throw new ConfigurationError(`${context} digest does not match`);
  }
  return { path: canonical, text: body.toString("utf8") };
}

function actorName(
  manifestDigest: string,
  runID: string,
  laneID: string,
): string {
  const suffix = laneID.replace(/[^a-z0-9_-]/g, "-").slice(0, 16);
  return normalizeActorName(
    `cast-${sha256(`${manifestDigest}\0${runID}\0${laneID}`).slice(0, 12)}-${suffix}`,
  );
}

function lanePrompt(goal: string, mission: string): string {
  return [
    "# Organism benchmark goal",
    "",
    goal.trim(),
    "",
    "# Your lane mission",
    "",
    mission.trim(),
    "",
  ].join("\n");
}

function backendArgs(
  backend: OrganismCastBackend,
  prompt: string,
): readonly string[] {
  if (backend === "claude") {
    const tools = "Bash,Edit,Read,Write,Glob,Grep";
    return [
      "--print",
      "--verbose",
      "--output-format",
      "stream-json",
      "--tools",
      tools,
      "--allowedTools",
      tools,
      "--disallowedTools",
      "WebFetch,WebSearch,Task,Agent",
      "--permission-mode",
      "dontAsk",
      "--prompt-suggestions",
      "false",
      prompt,
    ];
  }
  if (backend === "grok") {
    return [
      "--always-approve",
      "--disable-web-search",
      "--no-memory",
      "--no-subagents",
      "--no-plan",
      "--output-format",
      "json",
      "--single",
      prompt,
    ];
  }
  if (backend === "opencode") {
    return ["run", prompt];
  }
  if (backend === "codex") {
    return ["exec", "--json", prompt];
  }
  return ["-p", prompt];
}

function exactLaneSet(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== expected.length) return false;
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.every((value, index) => value === right[index]);
}

interface DeliveryProbeCase {
  id: string;
  arm: OrganismCastArm;
  record?: Record<string, unknown>;
  verdict: "pass" | "fail" | "unknown";
  delivered: boolean | null;
}

const DELIVERY_PROBE_CASES: readonly DeliveryProbeCase[] = [
  {
    id: "organum-delivered",
    arm: "organum",
    record: {
      schema: ORGANISM_DELIVERY_TELEMETRY_SCHEMA,
      polls: 1,
      prepared_turns: 1,
      admitted_turns: 1,
      exposed_items: 2,
      admitted_items: 2,
      relay_acks: 1,
    },
    verdict: "pass",
    delivered: true,
  },
  {
    id: "organum-available-zero-adoption",
    arm: "organum",
    record: {
      schema: ORGANISM_DELIVERY_TELEMETRY_SCHEMA,
      polls: 1,
      prepared_turns: 1,
      admitted_turns: 0,
      exposed_items: 2,
      admitted_items: 0,
      relay_acks: 0,
    },
    verdict: "fail",
    delivered: false,
  },
  {
    id: "conservation-unknown",
    arm: "organum",
    record: {
      schema: ORGANISM_DELIVERY_TELEMETRY_SCHEMA,
      polls: 1,
      prepared_turns: 1,
      admitted_turns: 1,
      exposed_items: 1,
      admitted_items: 2,
      relay_acks: 0,
    },
    verdict: "unknown",
    delivered: null,
  },
  {
    id: "turn-conservation-unknown",
    arm: "organum",
    record: {
      schema: ORGANISM_DELIVERY_TELEMETRY_SCHEMA,
      polls: 1,
      prepared_turns: 0,
      admitted_turns: 1,
      exposed_items: 1,
      admitted_items: 1,
      relay_acks: 0,
    },
    verdict: "unknown",
    delivered: null,
  },
  {
    id: "ack-conservation-unknown",
    arm: "organum",
    record: {
      schema: ORGANISM_DELIVERY_TELEMETRY_SCHEMA,
      polls: 1,
      prepared_turns: 1,
      admitted_turns: 1,
      exposed_items: 1,
      admitted_items: 1,
      relay_acks: 2,
    },
    verdict: "unknown",
    delivered: null,
  },
  {
    id: "counter-missing-unknown",
    arm: "organum",
    record: {
      schema: ORGANISM_DELIVERY_TELEMETRY_SCHEMA,
      polls: 1,
    },
    verdict: "unknown",
    delivered: null,
  },
  {
    id: "organum-zero-polls",
    arm: "organum",
    record: {
      schema: ORGANISM_DELIVERY_TELEMETRY_SCHEMA,
      polls: 0,
      prepared_turns: 1,
      admitted_turns: 1,
      exposed_items: 1,
      admitted_items: 1,
      relay_acks: 0,
    },
    verdict: "fail",
    delivered: false,
  },
  {
    id: "bare-contamination",
    arm: "bare",
    record: {
      schema: ORGANISM_DELIVERY_TELEMETRY_SCHEMA,
      polls: 1,
      prepared_turns: 1,
      admitted_turns: 0,
      exposed_items: 1,
      admitted_items: 0,
      relay_acks: 0,
    },
    verdict: "fail",
    delivered: true,
  },
  {
    id: "organum-missing",
    arm: "organum",
    verdict: "fail",
    delivered: false,
  },
  {
    id: "bare-clean",
    arm: "bare",
    verdict: "pass",
    delivered: false,
  },
];

async function qualifyDeliveryGate(
  evaluatorBody: string,
): Promise<readonly string[]> {
  const root = await mkdtemp(
    join(tmpdir(), "organum-code-delivery-gate-"),
  );
  const qualified: string[] = [];
  try {
    const evaluatorPath = join(root, "delivery.py");
    await writeFile(evaluatorPath, evaluatorBody, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    for (const probe of DELIVERY_PROBE_CASES) {
      const runDirectory = join(root, probe.id);
      await mkdir(runDirectory, { mode: 0o700 });
      if (probe.record !== undefined) {
        await writeFile(
          join(runDirectory, "lane.stderr.log"),
          `Organum Code coordination delivery: ${
            JSON.stringify(probe.record)
          }\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      }
      const result = spawnSync(
        "python3",
        [
          evaluatorPath,
          "--run-dir",
          runDirectory,
          "--arm",
          probe.arm,
          "--json",
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 128 * 1024,
          shell: false,
          cwd: root,
          env: {
            PATH: process.env.PATH,
            LANG: process.env.LANG ?? "C.UTF-8",
            LC_ALL: process.env.LC_ALL,
          },
        },
      );
      if (result.error !== undefined || result.signal !== null) {
        throw new ConfigurationError(
          `Organism delivery gate probe ${probe.id} did not settle`,
        );
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(result.stdout);
      } catch {
        throw new ConfigurationError(
          `Organism delivery gate probe ${probe.id} returned invalid JSON`,
        );
      }
      const output = z
        .object({
          schema: z.literal(ORGANISM_DELIVERY_TELEMETRY_SCHEMA),
          arm: z.literal(probe.arm),
          verdict: z.enum(["pass", "fail", "unknown"]),
          delivered: z.boolean().nullable(),
        })
        .passthrough()
        .parse(decoded);
      const expectedStatus = probe.verdict === "pass" ? 0 : 1;
      if (
        result.status !== expectedStatus ||
        output.verdict !== probe.verdict ||
        output.delivered !== probe.delivered
      ) {
        throw new ConfigurationError(
          `Organism delivery gate probe ${probe.id} does not match the ratified semantics`,
        );
      }
      qualified.push(probe.id);
    }
    return qualified;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function loadOrganismCastPlan(
  manifestPath: string,
): Promise<OrganismCastPlan> {
  const canonicalManifest = await regularFile(
    manifestPath,
    "Organism cast manifest",
  );
  const manifestMetadata = await lstat(canonicalManifest);
  if (manifestMetadata.size > MAX_MANIFEST_BYTES) {
    throw new ConfigurationError(
      `Organism cast manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
    );
  }
  const manifestBody = await readFile(canonicalManifest);
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestBody.toString("utf8"));
  } catch {
    throw new ConfigurationError("Organism cast manifest is not valid JSON");
  }
  const manifest = castManifestSchema.parse(decoded);
  const manifestDigest = sha256(manifestBody);
  let preregistrationSha256: string | null = null;
  let preregistrationPath: string | null = null;
  let preregisteredTimeoutMs: number | null = null;
  let findingDelivery: z.infer<typeof findingDeliveryPinSchema> | null = null;
  if (
    manifest.schema === ORGANISM_CAST_MANIFEST_SCHEMA ||
    manifest.schema === ORGANISM_CAST_MANIFEST_SCHEMA_V3
  ) {
    const canonicalPreregistrationPath = await regularFile(
      manifest.preregistration.path,
      "Organism cast preregistration",
    );
    const preregistrationMetadata = await lstat(canonicalPreregistrationPath);
    if (preregistrationMetadata.size > MAX_MANIFEST_BYTES) {
      throw new ConfigurationError(
        `Organism cast preregistration exceeds ${MAX_MANIFEST_BYTES} bytes`,
      );
    }
    const preregistrationBody = await readFile(canonicalPreregistrationPath);
    if (sha256(preregistrationBody) !== manifest.preregistration.sha256) {
      throw new ConfigurationError(
        "Organism cast preregistration digest does not match",
      );
    }
    let preregistrationDecoded: unknown;
    try {
      preregistrationDecoded = JSON.parse(
        preregistrationBody.toString("utf8"),
      );
    } catch {
      throw new ConfigurationError(
        "Organism cast preregistration is not valid JSON",
      );
    }
    const preregistration = manifest.schema === ORGANISM_CAST_MANIFEST_SCHEMA_V3
      ? castPreregistrationV3Schema.parse(preregistrationDecoded)
      : castPreregistrationSchema.parse(preregistrationDecoded);
    if (preregistration.preregistration_id !== manifest.preregistration_id) {
      throw new ConfigurationError(
        "Organism cast preregistration identity does not match the manifest",
      );
    }
    if (preregistration.cast_timeout_ms !== manifest.timeout_ms) {
      throw new ConfigurationError(
        "Organism cast timeout does not match the digest-bound preregistration",
      );
    }
    preregistrationSha256 = manifest.preregistration.sha256;
    preregistrationPath = canonicalPreregistrationPath;
    preregisteredTimeoutMs = preregistration.cast_timeout_ms;
    if (manifest.schema === ORGANISM_CAST_MANIFEST_SCHEMA_V3) {
      const preregistrationFindingDelivery = findingDeliveryPinSchema.parse(
        preregistration.finding_delivery,
      );
      if (
        preregistrationFindingDelivery.route.channel !==
            manifest.finding_delivery.route.channel ||
        preregistrationFindingDelivery.route.route_id !==
            manifest.finding_delivery.route.route_id ||
        preregistrationFindingDelivery.contract.registration_schema !==
            manifest.finding_delivery.contract.registration_schema ||
        preregistrationFindingDelivery.contract.receipt_schema !==
            manifest.finding_delivery.contract.receipt_schema ||
        preregistrationFindingDelivery.contract.lifecycle_schema !==
            manifest.finding_delivery.contract.lifecycle_schema
      ) {
        throw new ConfigurationError(
          "Organism cast finding-delivery pin differs between manifest and preregistration",
        );
      }
      const expectedChannel = manifest.arm === "organum"
        ? "organum_coordination"
        : "bare_no_coordination";
      if (manifest.finding_delivery.route.channel !== expectedChannel) {
        throw new ConfigurationError(
          "Organism cast finding-delivery route does not match the explicit arm",
        );
      }
      findingDelivery = manifest.finding_delivery;
    }
  }
  const runDirectory = await existingDirectory(
    manifest.run_directory,
    "Organism cast run directory",
  );
  const workDirectory = await existingDirectory(
    manifest.work_directory,
    "Organism cast work directory",
  );
  if (
    workDirectory !== join(runDirectory, "work") ||
    !inside(runDirectory, workDirectory)
  ) {
    throw new ConfigurationError(
      "Organism cast work directory must be the run directory's exact work child",
    );
  }
  const requestedStateDirectory = resolve(manifest.state_directory);
  if (
    requestedStateDirectory !==
      join(resolve(manifest.run_directory), "state") ||
    inside(workDirectory, join(runDirectory, "state")) ||
    inside(join(runDirectory, "state"), workDirectory)
  ) {
    throw new ConfigurationError(
      "Organism cast state directory must be the run directory's disjoint state child",
    );
  }
  const stateDirectory = join(runDirectory, "state");

  const packManifest = await regularFile(
    manifest.pack.manifest.path,
    "Organism benchmark pack manifest",
  );
  const packMetadata = await lstat(packManifest);
  if (packMetadata.size > MAX_MANIFEST_BYTES) {
    throw new ConfigurationError(
      `Organism benchmark pack manifest exceeds ${MAX_MANIFEST_BYTES} bytes`,
    );
  }
  const packBody = await readFile(packManifest);
  if (sha256(packBody) !== manifest.pack.manifest.sha256) {
    throw new ConfigurationError(
      "Organism benchmark pack manifest digest does not match",
    );
  }
  let packDecoded: unknown;
  try {
    packDecoded = JSON.parse(packBody.toString("utf8"));
  } catch {
    throw new ConfigurationError(
      "Organism benchmark pack manifest is not valid JSON",
    );
  }
  const pack = packIndexSchema.parse(packDecoded);
  if (pack.id !== manifest.pack.id) {
    throw new ConfigurationError(
      "Organism cast pack identity does not match its manifest",
    );
  }
  const declaredLaneIDs = manifest.lanes.map((lane) => lane.id);
  const packLaneIDs = pack.lanes.map((lane) => lane.id);
  if (
    new Set(declaredLaneIDs).size !== declaredLaneIDs.length ||
    new Set(packLaneIDs).size !== packLaneIDs.length
  ) {
    throw new ConfigurationError(
      "Organism cast and benchmark pack lane identities must be unique",
    );
  }
  if (
    !exactLaneSet(
      declaredLaneIDs,
      packLaneIDs,
    )
  ) {
    throw new ConfigurationError(
      "Organism cast lanes must exactly match the benchmark pack",
    );
  }

  const packDirectory = dirname(packManifest);
  let deliveryGate: OrganismCastDeliveryGate | null = null;
  if (manifest.delivery_gate !== undefined) {
    const benchmarkRoot = dirname(dirname(packDirectory));
    const expectedPackManifest = join(
      benchmarkRoot,
      "packs",
      manifest.pack.id,
      "pack.json",
    );
    if (packManifest !== expectedPackManifest) {
      throw new ConfigurationError(
        "A delivery-gated cast pack must use the benchmark root's exact packs/<id>/pack.json",
      );
    }
    const evaluator = await boundedText(
      manifest.delivery_gate.evaluator.path,
      manifest.delivery_gate.evaluator.sha256,
      "Organism benchmark delivery gate evaluator",
    );
    if (
      evaluator.path !== join(benchmarkRoot, "harness", "delivery.py")
    ) {
      throw new ConfigurationError(
        "Organism delivery gate must be the benchmark root's exact harness/delivery.py",
      );
    }
    deliveryGate = {
      telemetrySchema: manifest.delivery_gate.telemetry_schema,
      evaluatorPath: evaluator.path,
      evaluatorSha256: manifest.delivery_gate.evaluator.sha256,
      qualificationCases: await qualifyDeliveryGate(evaluator.text),
    };
  }
  const goalPath = join(packDirectory, "mission", "goal.md");
  const goal = await boundedText(
    manifest.goal.path,
    manifest.goal.sha256,
    "Organism cast goal",
  );
  if (goal.path !== goalPath) {
    throw new ConfigurationError(
      "Organism cast goal must be the pack's exact mission/goal.md",
    );
  }
  const seenProfiles = new Set<string>();
  const lanes: OrganismCastLanePlan[] = [];
  for (const lane of manifest.lanes) {
    const expectedMission = join(
      packDirectory,
      "mission",
      "lanes",
      `${lane.id}.md`,
    );
    const profile = normalizeUserProfileName(lane.profile);
    if (seenProfiles.has(profile)) {
      throw new ConfigurationError(
        "Organism cast requires one distinct profile per lane",
      );
    }
    seenProfiles.add(profile);
    const mission = await boundedText(
      lane.mission.path,
      lane.mission.sha256,
      `Organism cast lane ${lane.id} mission`,
    );
    if (mission.path !== expectedMission) {
      throw new ConfigurationError(
        `Organism cast lane ${lane.id} must use its exact pack mission`,
      );
    }
    const prompt = lanePrompt(goal.text, mission.text);
    const actor = actorName(manifestDigest, manifest.run_id, lane.id);
    lanes.push({
      id: lane.id,
      actor,
      profile,
      backend: lane.backend,
      missionSha256: lane.mission.sha256,
      promptSha256: sha256(prompt),
      args: lane.backend === "opencode"
        ? [
            "--profile",
            profile,
            lane.backend,
            ...backendArgs(lane.backend, prompt),
          ]
        : [
            "--actor",
            actor,
            "--profile",
            profile,
            lane.backend,
            ...backendArgs(lane.backend, prompt),
          ],
      environment: {
        ORGANUM_CODE_COORDINATION:
          manifest.arm === "organum" ? "on" : "off",
        ORGANUM_CODE_OBSERVATION:
          manifest.arm === "organum" ? "required" : "artifact",
        ORGANUM_CODE_STATE_DIR: stateDirectory,
        ORGANUM_CODE_CAST_LANE: "1",
        ORGANUM_CODE_CAST_RUN_ID: manifest.run_id,
        ORGANUM_CODE_CAST_RUN_DIRECTORY: runDirectory,
        ORGANUM_CODE_CAST_PACK: manifest.pack.id,
        ORGANUM_CODE_CAST_ARM: manifest.arm,
        ORGANUM_CODE_CAST_LANE_ID: lane.id,
        ORGANUM_CODE_CAST_COMPARISON_KEY: manifest.comparison_key,
        ORGANUM_CODE_CAST_PREREGISTRATION_ID:
          manifest.preregistration_id,
        ORGANUM_CODE_CAST_PROMPT_SHA256: sha256(prompt),
        ...(lane.backend === "opencode"
          ? {
              ORGANUM_CODE_FIRST_PARTY_PLUGIN:
                manifest.arm === "organum" ? "1" : "0",
            }
          : {}),
        ORGANUM_CODE_INTENT:
          `organism bench ${manifest.pack.id}/${lane.id}`,
      },
    });
  }

  return {
    schema: manifest.schema,
    manifestPath: canonicalManifest,
    manifestSha256: manifestDigest,
    runID: manifest.run_id,
    arm: manifest.arm,
    packID: manifest.pack.id,
    packSha256: manifest.pack.manifest.sha256,
    comparisonKey: manifest.comparison_key,
    preregistrationID: manifest.preregistration_id,
    preregistrationPath,
    preregistrationSha256,
    preregisteredTimeoutMs,
    deliveryGate,
    findingDelivery,
    runDirectory,
    workDirectory,
    stateDirectory,
    logDirectory: join(runDirectory, "cast-logs"),
    donePath: join(runDirectory, "DONE"),
    resultPath: join(runDirectory, "cast-result.json"),
    goalSha256: manifest.goal.sha256,
    timeoutMs: manifest.timeout_ms,
    lanes,
  };
}

export function organismCastCheck(plan: OrganismCastPlan): Record<string, unknown> {
  const hasOpenCode = plan.lanes.some(
    (lane) => lane.backend === "opencode",
  );
  const deepCodePtyReady =
    !plan.lanes.some((lane) => lane.backend === "deepcode") ||
    process.platform === "darwin";
  return {
    schema: "organum-code/organism-cast-check/v1",
    manifest_sha256: plan.manifestSha256,
    run_id: plan.runID,
    arm: plan.arm,
    pack: plan.packID,
    comparison_key: plan.comparisonKey,
    timeout_ms: plan.timeoutMs,
    deadline_policy: {
      kind: "elapsed_wall_clock",
      starts: "before_lane_launch",
      action: "terminate_active_lane_process_trees",
      result_classification: "right_censored_by_deadline",
    },
    preregistration: {
      id: plan.preregistrationID,
      sha256: plan.preregistrationSha256,
      cast_timeout_ms: plan.preregisteredTimeoutMs,
      manifest_timeout_match:
        plan.preregisteredTimeoutMs === plan.timeoutMs,
    },
    lanes: plan.lanes.map((lane) => ({
      id: lane.id,
      actor: lane.actor,
      profile: lane.profile,
      backend: lane.backend,
      mission_sha256: lane.missionSha256,
      prompt_sha256: lane.promptSha256,
      human_input_transport: {
        schema: "organum-code/human-input-request/v1",
        requests: relative(
          plan.runDirectory,
          organismCastHumanInputPaths(plan.stateDirectory, lane.id)
            .requestDirectory,
        ),
        responses: relative(
          plan.runDirectory,
          organismCastHumanInputPaths(plan.stateDirectory, lane.id)
            .responseDirectory,
        ),
        carries_coordination_payload: false,
      },
    })),
    capabilities: {
      mechanical_cast_supervision: true,
      persistent_actor_arm_separation: !hasOpenCode,
      opencode_session_root_coordination: hasOpenCode,
      opencode_cast_receipt_telemetry: hasOpenCode,
      opencode_process_tree_cancellation: hasOpenCode,
      supervisor_only_done: true,
      oob_organum_cli_environment: true,
      observation_artifact: true,
      organum_pull_surface: true,
      organum_r3_filtered_consume_provider_zero: true,
      organum_delivery_gate: plan.deliveryGate !== null,
      deepcode_bounded_pty: deepCodePtyReady,
      deepcode_pty_output_compaction: deepCodePtyReady,
      deepcode_completion_receipt_exit: deepCodePtyReady,
      backend_neutral_human_input_transport: true,
      blocked_on_human_input_observation: deepCodePtyReady,
      digest_bound_preregistered_timeout:
        plan.preregisteredTimeoutMs === plan.timeoutMs,
      provider_request_coordination_repull: true,
      provider_request_overlap_ordered: true,
      raw_provider_usage_ledger: true,
      oob_origin_projection: true,
      finding_delivery_v3:
        plan.schema === ORGANISM_CAST_MANIFEST_SCHEMA_V3 &&
        plan.findingDelivery !== null,
    },
    delivery_gate:
      plan.deliveryGate === null
        ? null
        : {
            telemetry_schema: plan.deliveryGate.telemetrySchema,
            evaluator_sha256: plan.deliveryGate.evaluatorSha256,
            qualification_cases: plan.deliveryGate.qualificationCases,
          },
    provider_calls: 0,
    structural_ready:
      deepCodePtyReady &&
      (plan.schema === ORGANISM_CAST_MANIFEST_SCHEMA ||
        (plan.schema === ORGANISM_CAST_MANIFEST_SCHEMA_V3 &&
          plan.findingDelivery !== null)) &&
      plan.preregisteredTimeoutMs === plan.timeoutMs &&
      (plan.arm === "bare" || plan.deliveryGate !== null),
    provider_active_qualified: false,
  };
}

function selfCommand(): { executable: string; prefix: readonly string[] } {
  const entrypoint = process.argv[1] ?? "";
  if (
    entrypoint.endsWith("/src/main.ts") ||
    entrypoint.endsWith("/dist/src/main.js") ||
    entrypoint.endsWith("\\src\\main.ts") ||
    entrypoint.endsWith("\\dist\\src\\main.js")
  ) {
    return { executable: process.execPath, prefix: [entrypoint] };
  }
  return { executable: process.execPath, prefix: [] };
}

export function prepareOrganismCastLaneCommand(
  backend: OrganismCastBackend,
  command: { executable: string; prefix: readonly string[] },
  args: readonly string[],
  completionReceiptPath?: string,
  humanInput?: OrganismCastHumanInputPaths & {
    runID: string;
    laneID: string;
  },
): { executable: string; args: readonly string[]; pty: boolean } {
  const direct = {
    executable: command.executable,
    args: [...command.prefix, ...args],
    pty: false,
  };
  if (backend !== "deepcode") return direct;
  const bridged = prepareMacosPtyBridge(direct.executable, direct.args, {
    ...(completionReceiptPath === undefined
      ? {}
      : { completionReceiptPath }),
    ...(humanInput === undefined
      ? {}
      : {
          humanInput: {
            requestDirectory: humanInput.requestDirectory,
            responseDirectory: humanInput.responseDirectory,
            receiptDirectory: humanInput.receiptDirectory,
            runID: humanInput.runID,
            laneID: humanInput.laneID,
            backend,
          },
        }),
  });
  return { ...bridged, pty: true };
}

export function organismCastDeepCodeCompletionReceiptPath(
  lane: OrganismCastLanePlan,
  plan: OrganismCastPlan,
): string {
  if (lane.backend !== "deepcode") {
    throw new TypeError(
      "A cast completion receipt path is defined only for Deep Code lanes",
    );
  }
  return join(
    plan.stateDirectory,
    "actors",
    actorWorkspaceFingerprint(plan.workDirectory),
    lane.profile,
    lane.backend,
    lane.actor,
    "runtime",
    "completion.json",
  );
}

function terminateTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") process.kill(pid, "SIGTERM");
    else process.kill(-pid, "SIGTERM");
  } catch {
    // The lane may already have exited.
  }
}

function scrubCastEnvironment(
  environment: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const output = { ...process.env };
  for (const name of [
    "ORGANUM_CODE_ACTOR",
    "ORGANUM_CODE_BACKEND",
    "ORGANUM_CODE_PASSTHROUGH_ENV",
    "ORGANUM_CODE_PROFILE",
  ]) {
    delete output[name];
  }
  return { ...output, ...environment };
}

async function defaultLaneExecutor(
  lane: OrganismCastLanePlan,
  plan: OrganismCastPlan,
  signal: AbortSignal,
): Promise<OrganismCastLaneResult> {
  const command = selfCommand();
  const completionReceiptPath = lane.backend === "deepcode"
    ? organismCastDeepCodeCompletionReceiptPath(lane, plan)
    : undefined;
  const humanInputPaths = organismCastHumanInputPaths(
    plan.stateDirectory,
    lane.id,
  );
  await Promise.all([
    ensurePrivateDirectory(humanInputPaths.requestDirectory),
    ensurePrivateDirectory(humanInputPaths.responseDirectory),
    ensurePrivateDirectory(humanInputPaths.receiptDirectory),
  ]);
  const existingHumanInputRecords = (
    await Promise.all([
      readdir(humanInputPaths.requestDirectory),
      readdir(humanInputPaths.responseDirectory),
      readdir(humanInputPaths.receiptDirectory),
    ])
  ).flat();
  if (existingHumanInputRecords.length > 0) {
    throw new ConfigurationError(
      `Organism cast lane ${lane.id} human-input transport is not fresh`,
    );
  }
  if (completionReceiptPath !== undefined) {
    // A cast launch must never consume a receipt left by an interrupted
    // provider-zero rehearsal. The launcher recreates it atomically.
    await rm(completionReceiptPath, { force: true });
  }
  const laneCommand = prepareOrganismCastLaneCommand(
    lane.backend,
    command,
    lane.args,
    completionReceiptPath,
    {
      ...humanInputPaths,
      runID: plan.runID,
      laneID: lane.id,
    },
  );
  return await new Promise<OrganismCastLaneResult>((resolveLane) => {
    const child = spawn(
      laneCommand.executable,
      [...laneCommand.args],
      {
        cwd: plan.workDirectory,
        env: scrubCastEnvironment(lane.environment),
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let terminatedByDeadline = false;
    const abort = (): void => {
      terminatedByDeadline = true;
      terminateTree(child.pid);
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_LANE_OUTPUT_BYTES) {
        outputExceeded = true;
        terminateTree(child.pid);
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_LANE_OUTPUT_BYTES) {
        outputExceeded = true;
        terminateTree(child.pid);
        return;
      }
      stderr.push(chunk);
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      stderr.push(Buffer.from(error.message, "utf8"));
      resolveLane({
        id: lane.id,
        actor: lane.actor,
        backend: lane.backend,
        exitCode: 1,
        signal: null,
        outputExceeded,
        outputCompacted: laneCommand.pty ? null : false,
        outputDiscardedBytes: laneCommand.pty ? null : 0,
        terminated_by_deadline: terminatedByDeadline,
        completion_receipt_observed: false,
        completion_receipt_status: null,
        completion_receipt_at: null,
        human_input_state: "not_observed",
        blocked_at: null,
        question_id: null,
        human_input_answered_at: null,
        human_input_events: [],
      });
    });
    child.once("close", async (code, closeSignal) => {
      signal.removeEventListener("abort", abort);
      const stdoutOutput = Buffer.concat(stdout);
      const stderrOutput = Buffer.concat(stderr);
      const compaction = laneCommand.pty
        ? parsePtyBridgeCompactionTelemetry(stderrOutput)
        : null;
      const completionReceipt = laneCommand.pty
        ? parsePtyBridgeCompletionReceiptTelemetry(stderrOutput)
        : null;
      const humanInputEvents = await readOrganismCastHumanInputEvents(
        humanInputPaths,
        {
          runID: plan.runID,
          laneID: lane.id,
          backend: lane.backend,
        },
      );
      const unresolvedHumanInput = humanInputEvents.find(
        (event) => event.state === "blocked_on_human_input",
      );
      const latestHumanInput =
        unresolvedHumanInput ??
        humanInputEvents[humanInputEvents.length - 1] ??
        null;
      await Promise.all([
        writeFile(
          join(plan.logDirectory, `${lane.id}.stdout.log`),
          stdoutOutput,
          { mode: 0o600, flag: "wx" },
        ),
        writeFile(
          join(plan.logDirectory, `${lane.id}.stderr.log`),
          stderrOutput,
          { mode: 0o600, flag: "wx" },
        ),
      ]).catch(() => undefined);
      resolveLane({
        id: lane.id,
        actor: lane.actor,
        backend: lane.backend,
        exitCode: outputExceeded ? 1 : code,
        signal: closeSignal,
        outputExceeded,
        outputCompacted:
          laneCommand.pty ? compaction?.compacted ?? null : false,
        outputDiscardedBytes:
          laneCommand.pty ? compaction?.discardedBytes ?? null : 0,
        terminated_by_deadline: terminatedByDeadline,
        completion_receipt_observed: completionReceipt !== null,
        completion_receipt_status: completionReceipt?.status ?? null,
        completion_receipt_at: completionReceipt?.observedAt ?? null,
        human_input_state:
          unresolvedHumanInput !== undefined
            ? "blocked_on_human_input"
            : humanInputEvents.length > 0
            ? "answered"
            : "not_observed",
        blocked_at: latestHumanInput?.blocked_at ?? null,
        question_id: latestHumanInput?.question_id ?? null,
        human_input_answered_at: latestHumanInput?.answered_at ?? null,
        human_input_events: humanInputEvents,
      });
    });
  });
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new ConfigurationError(
      "Organism cast state and log directories must be private real directories",
    );
  }
}

async function writeAtomicPrivateJson(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function runOrganismCast(
  plan: OrganismCastPlan,
  dependencies: {
    executor?: OrganismCastExecutor;
    providerExecutionAuthorized?: boolean;
  } = {},
): Promise<OrganismCastRunResult> {
  if (
    plan.schema !== ORGANISM_CAST_MANIFEST_SCHEMA ||
    plan.preregisteredTimeoutMs !== plan.timeoutMs
  ) {
    throw new ConfigurationError(
      "Organism cast run requires a v2 manifest with a digest-bound matching preregistered timeout",
    );
  }
  if (plan.arm === "organum" && plan.deliveryGate === null) {
    throw new ConfigurationError(
      "Organism cast organum arm is blocked: the manifest does not bind a provider-zero-qualified benchmark delivery gate",
    );
  }
  if (await lstat(plan.donePath).then(() => true).catch(() => false)) {
    throw new ConfigurationError(
      "Organism cast DONE already exists; use a fresh run directory",
    );
  }
  if (await lstat(plan.resultPath).then(() => true).catch(() => false)) {
    throw new ConfigurationError(
      "Organism cast result already exists; use a fresh run directory",
    );
  }
  await Promise.all([
    ensurePrivateDirectory(plan.stateDirectory),
    ensurePrivateDirectory(plan.logDirectory),
  ]);
  const startedAt = new Date();
  const deadlineAt = new Date(startedAt.getTime() + plan.timeoutMs);
  const controller = new AbortController();
  let deadlineExceeded = false;
  const timer = setTimeout(
    () => {
      deadlineExceeded = true;
      controller.abort(new Error("Organism cast deadline exceeded"));
    },
    plan.timeoutMs,
  );
  const providerExecutionAuthorized =
    dependencies.providerExecutionAuthorized ?? true;
  if (!providerExecutionAuthorized && dependencies.executor === undefined) {
    throw new ConfigurationError(
      "Provider-zero cast rehearsal requires an explicit fake executor",
    );
  }
  const executor = dependencies.executor ?? defaultLaneExecutor;
  let lanes: OrganismCastLaneExecutionResult[];
  try {
    lanes = await Promise.all(
      plan.lanes.map(async (lane) =>
        await executor(lane, plan, controller.signal)
      ),
    );
  } finally {
    clearTimeout(timer);
  }
  const normalizedLanes = lanes.map((lane) => {
    const laneFailed =
      lane.exitCode !== 0 ||
      lane.signal !== null ||
      lane.outputExceeded;
    return {
      ...lane,
      terminated_by_deadline:
        lane.terminated_by_deadline ??
        (deadlineExceeded && laneFailed),
      completion_receipt_observed:
        lane.completion_receipt_observed ?? false,
      completion_receipt_status:
        lane.completion_receipt_status ?? null,
      completion_receipt_at:
        lane.completion_receipt_at ?? null,
      human_input_state:
        lane.human_input_state ?? "not_observed",
      blocked_at: lane.blocked_at ?? null,
      question_id: lane.question_id ?? null,
      human_input_answered_at:
        lane.human_input_answered_at ?? null,
      human_input_events: lane.human_input_events ?? [],
    } satisfies OrganismCastLaneResult;
  });
  const blockedOnHumanInput = normalizedLanes.some(
    (lane) => lane.human_input_state === "blocked_on_human_input",
  );
  const completed = !deadlineExceeded && !blockedOnHumanInput &&
    normalizedLanes.every(
    (lane) =>
      lane.exitCode === 0 &&
      lane.signal === null &&
      lane.outputExceeded === false,
  );
  const finishedAt = new Date();
  const result: OrganismCastRunResult = {
    schema: ORGANISM_CAST_RESULT_SCHEMA,
    run_id: plan.runID,
    arm: plan.arm,
    pack: plan.packID,
    manifest_sha256: plan.manifestSha256,
    comparison_key: plan.comparisonKey,
    provider_execution_authorized: providerExecutionAuthorized,
    organum_consume_capability:
      plan.arm === "organum" && plan.deliveryGate !== null,
    started_at: startedAt.toISOString(),
    timeout_ms: plan.timeoutMs,
    deadline_at: deadlineAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    truncated_by_deadline: deadlineExceeded,
    abort_reason:
      deadlineExceeded
        ? "deadline_exceeded"
        : blockedOnHumanInput
        ? "blocked_on_human_input"
        : null,
    right_censored_by_deadline: deadlineExceeded,
    completed,
    lanes: normalizedLanes,
  };
  await writeAtomicPrivateJson(plan.resultPath, result);
  if (completed) {
    await writeAtomicPrivateJson(plan.donePath, {
      schema: "organum-code/organism-cast-done/v1",
      run_id: plan.runID,
      result: basename(plan.resultPath),
      result_sha256: sha256(await readFile(plan.resultPath)),
    });
  }
  return result;
}
