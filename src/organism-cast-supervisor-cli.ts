import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import { z } from "zod";

import {
  findingDeliveryArtifactSha256,
  findingDeliveryCastBindingSchema,
  findingDeliveryLifecycleSchema,
  findingDeliveryReceiptSchema,
  type FindingDeliveryLifecycle,
  type FindingDeliveryReceipt,
} from "./finding-delivery.js";
import {
  FindingDeliveryBrokerBoundary,
  type FindingDeliveryProviderSemanticInputEvidence,
} from "./finding-delivery-broker-boundary.js";
import { InferenceBroker } from "./inference-broker.js";
import {
  loadOrganismCastPlan,
  ORGANISM_CAST_MANIFEST_SCHEMA_V3,
  ORGANISM_CAST_RESULT_SCHEMA_V3,
  type OrganismCastPlan,
} from "./organism-cast.js";
import {
  decodeOrganismCastStartPrivateFrames,
  organismCastFindingPacketAdmission,
  organismCastPrepareRequestSchema,
  organismCastStartRequestSchema,
  OrganismCastV3Supervisor,
  type OrganismCastAcceptedAdmission,
  type OrganismCastPrepareReceipt,
  type OrganismCastStartReceipt,
} from "./organism-cast-supervisor.js";
import { ConfigurationError } from "./provider-profile.js";

export const ORGANISM_CAST_PROVIDER_ZERO_OBSERVATION_SCHEMA =
  "organum-code/organism-cast-provider-zero-observation/v1" as const;
export const ORGANISM_CAST_PROVIDER_ZERO_OBSERVATION_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-organism-cast-provider-zero-observation-v1.schema.json" as const;

const MAX_CONTROL_BYTES = 128 * 1024;
const MAX_PRIVATE_FRAME_BYTES = 5 * 1024 * 1024;
const LOCK_ATTEMPTS = 5_000;
const PROVIDER_ZERO_TOKEN = "0123456789abcdefghijklmnopqrstuv";

export const organismCastProviderZeroFaultSchema = z.enum([
  "none",
  "lost-response",
  "network",
  "non-2xx",
  "durability-gap",
  "ambiguous-launch",
]);

export type OrganismCastProviderZeroFault = z.infer<
  typeof organismCastProviderZeroFaultSchema
>;

export const organismCastProviderZeroObservationSchema = z
  .object({
    schema: z.literal(ORGANISM_CAST_PROVIDER_ZERO_OBSERVATION_SCHEMA),
    producer_revision: z.string().regex(/^[0-9a-f]{40}$/),
    run_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    arm: z.enum(["organum", "bare"]),
    prepare_id: z.string().regex(/^prepare-[0-9a-f]{32}$/),
    idempotency_key: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    fault_mode: organismCastProviderZeroFaultSchema,
    prepare_call_count: z.number().int().nonnegative(),
    start_call_count: z.number().int().nonnegative(),
    packet_admission_count: z.number().int().nonnegative(),
    launch_attempt_count: z.number().int().nonnegative(),
    upstream_request_count: z.number().int().nonnegative(),
    semantic_persist_attempt_count: z.number().int().nonnegative(),
    packet_resend_count: z.number().int().nonnegative(),
    durable_phase: z.enum(["prepared", "started", "incomplete"]),
    receipt_emitted: z.boolean(),
    cast_result_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    recorded_at: z.string().datetime(),
  })
  .strict();

export type OrganismCastProviderZeroObservation = z.infer<
  typeof organismCastProviderZeroObservationSchema
>;

interface ParsedCommand {
  operation: "prepare" | "start";
  stateRoot: string;
  producerRevision: string;
  privateInputFD: 3 | null;
  fault: OrganismCastProviderZeroFault;
}

interface ProviderZeroOutcome {
  kind: "delivered" | "not_delivered" | "unknown";
  evidence: FindingDeliveryProviderSemanticInputEvidence | null;
}

interface StartExecution {
  receipt: OrganismCastStartReceipt;
  observation: OrganismCastProviderZeroObservation;
  emitReceipt: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function parseCommand(args: readonly string[]): ParsedCommand {
  const operation = args[0];
  if (operation !== "prepare" && operation !== "start") {
    throw new ConfigurationError(
      "cast supervisor requires prepare or start",
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      ![
        "--state-root",
        "--producer-revision",
        "--private-input-fd",
        "--fault",
      ].includes(name) ||
      values.has(name)
    ) {
      throw new ConfigurationError(
        "cast supervisor options are missing, duplicated, or unknown",
      );
    }
    values.set(name, value);
  }
  const stateRoot = values.get("--state-root");
  const producerRevision = values.get("--producer-revision");
  if (
    stateRoot === undefined ||
    !isAbsolute(stateRoot) ||
    stateRoot.includes("\0") ||
    Buffer.byteLength(stateRoot, "utf8") > 4_096 ||
    producerRevision === undefined ||
    !/^[0-9a-f]{40}$/.test(producerRevision)
  ) {
    throw new ConfigurationError(
      "cast supervisor requires an absolute state root and 40-hex producer revision",
    );
  }
  const rawFD = values.get("--private-input-fd");
  const rawFault = values.get("--fault") ?? "none";
  const fault = organismCastProviderZeroFaultSchema.parse(rawFault);
  if (operation === "prepare") {
    if (rawFD !== undefined || values.has("--fault")) {
      throw new ConfigurationError(
        "cast supervisor prepare does not accept private input or a fault mode",
      );
    }
    return {
      operation,
      stateRoot: resolve(stateRoot),
      producerRevision,
      privateInputFD: null,
      fault: "none",
    };
  }
  if (rawFD !== "3") {
    throw new ConfigurationError(
      "cast supervisor start requires the exact private input FD 3",
    );
  }
  return {
    operation,
    stateRoot: resolve(stateRoot),
    producerRevision,
    privateInputFD: 3,
    fault,
  };
}

async function readBounded(stream: Readable, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maximum) {
      stream.destroy();
      throw new ConfigurationError("cast supervisor input exceeds its byte bound");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes: Buffer): unknown {
  if (bytes.length === 0) {
    throw new ConfigurationError("cast supervisor request stdin is empty");
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ConfigurationError("cast supervisor request stdin is invalid JSON");
  }
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
      "cast supervisor adapter state must be a private real directory",
    );
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      return async () => await rmdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
    }
  }
  throw new ConfigurationError("cast supervisor adapter lock timed out");
}

async function writeAtomicPrivate(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
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
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function writeExactPrivate(path: string, bytes: Buffer): Promise<void> {
  const existing = await readFile(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (existing !== null) {
    if (!existing.equals(bytes)) {
      throw new ConfigurationError(
        "cast supervisor final artifact conflicts with durable bytes",
      );
    }
    return;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
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

export function organismCastProviderZeroObservationPath(
  stateRoot: string,
): string {
  return join(resolve(stateRoot), "provider-zero-observation.json");
}

async function readObservation(
  stateRoot: string,
): Promise<OrganismCastProviderZeroObservation | null> {
  const bytes = await readFile(
    organismCastProviderZeroObservationPath(stateRoot),
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (bytes === null) return null;
  try {
    return organismCastProviderZeroObservationSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
  } catch {
    throw new ConfigurationError(
      "cast supervisor provider-zero observation is malformed",
    );
  }
}

async function writeObservation(
  stateRoot: string,
  observation: OrganismCastProviderZeroObservation,
): Promise<void> {
  const exact = organismCastProviderZeroObservationSchema.parse(observation);
  await writeAtomicPrivate(
    organismCastProviderZeroObservationPath(stateRoot),
    canonicalJsonBytes(exact),
  );
}

function requireTrackBPlan(plan: OrganismCastPlan): void {
  if (
    plan.schema !== ORGANISM_CAST_MANIFEST_SCHEMA_V3 ||
    plan.preregistrationPath === null ||
    plan.preregistrationSha256 === null ||
    plan.findingDelivery === null
  ) {
    throw new ConfigurationError(
      "cast supervisor subprocess requires a finding-delivery-bound v3 manifest",
    );
  }
}

function initialObservation(
  receipt: OrganismCastPrepareReceipt,
): OrganismCastProviderZeroObservation {
  return organismCastProviderZeroObservationSchema.parse({
    schema: ORGANISM_CAST_PROVIDER_ZERO_OBSERVATION_SCHEMA,
    producer_revision: receipt.producer_revision,
    run_id: receipt.run_id,
    arm: receipt.arm,
    prepare_id: receipt.prepare_id,
    idempotency_key: null,
    fault_mode: "none",
    prepare_call_count: 1,
    start_call_count: 0,
    packet_admission_count: 0,
    launch_attempt_count: 0,
    upstream_request_count: 0,
    semantic_persist_attempt_count: 0,
    packet_resend_count: 0,
    durable_phase: "prepared",
    receipt_emitted: false,
    cast_result_sha256: null,
    recorded_at: new Date().toISOString(),
  });
}

function assertObservationIdentity(
  observation: OrganismCastProviderZeroObservation,
  input: {
    producerRevision: string;
    runID: string;
    arm: "organum" | "bare";
    prepareID: string;
  },
): void {
  if (
    observation.producer_revision !== input.producerRevision ||
    observation.run_id !== input.runID ||
    observation.arm !== input.arm ||
    observation.prepare_id !== input.prepareID
  ) {
    throw new ConfigurationError(
      "cast supervisor observation identity conflicts with the request",
    );
  }
}

export async function prepareOrganismCastProviderZero(
  stateRoot: string,
  producerRevision: string,
  rawRequest: unknown,
): Promise<OrganismCastPrepareReceipt> {
  await ensurePrivateDirectory(stateRoot);
  const request = organismCastPrepareRequestSchema.parse(rawRequest);
  const plan = await loadOrganismCastPlan(request.manifest.path);
  requireTrackBPlan(plan);
  const release = await acquireLock(join(stateRoot, ".provider-zero-adapter.lock"));
  try {
    const supervisor = new OrganismCastV3Supervisor(stateRoot, {
      producerRevision,
      launch() {},
    });
    const receipt = await supervisor.prepare(request);
    const existing = await readObservation(stateRoot);
    const observation = existing === null
      ? initialObservation(receipt)
      : (() => {
        assertObservationIdentity(existing, {
          producerRevision,
          runID: receipt.run_id,
          arm: receipt.arm,
          prepareID: receipt.prepare_id,
        });
        return organismCastProviderZeroObservationSchema.parse({
          ...existing,
          prepare_call_count: existing.prepare_call_count + 1,
          recorded_at: new Date().toISOString(),
        });
      })();
    await writeObservation(stateRoot, observation);
    return receipt;
  } finally {
    await release();
  }
}

function providerResponse(): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl-organism-cast-provider-zero",
    object: "chat.completion",
    model: "provider-zero",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "provider-zero terminal" },
      finish_reason: "stop",
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function runProviderZeroBoundary(
  boundary: FindingDeliveryBrokerBoundary,
  fault: OrganismCastProviderZeroFault,
  observation: OrganismCastProviderZeroObservation,
): Promise<ProviderZeroOutcome> {
  const broker = new InferenceBroker({
    upstreamBaseURL: "https://provider.invalid/v1",
    upstreamApiKey: "provider-zero-no-credential",
    upstreamModel: "provider-zero",
    mode: "chat-completions",
    token: PROVIDER_ZERO_TOKEN,
    requestLifecycle: boundary,
    fetch: async () => {
      if (observation.upstream_request_count > 0) {
        observation.packet_resend_count += 1;
      }
      observation.upstream_request_count += 1;
      if (fault === "network") {
        throw new Error("provider-zero network fault");
      }
      if (fault === "non-2xx") {
        return new Response("provider-zero rejected", { status: 429 });
      }
      return providerResponse();
    },
  });
  const session = await broker.start();
  try {
    const response = await fetch(`${session.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${PROVIDER_ZERO_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "provider-zero",
        messages: [{ role: "user", content: "provider-zero cast" }],
      }),
    });
    await response.text();
    const evidence = boundary.deliveryEvidence();
    if (fault === "durability-gap") {
      return { kind: "unknown", evidence: null };
    }
    if (response.ok && evidence.length === 1) {
      return { kind: "delivered", evidence: evidence[0] ?? null };
    }
    return { kind: "not_delivered", evidence: null };
  } finally {
    await broker.close();
  }
}

async function finalizeFindingDelivery(
  plan: OrganismCastPlan,
  producerRevision: string,
  admission: OrganismCastAcceptedAdmission,
  idempotencyKey: string,
  outcome: ProviderZeroOutcome,
): Promise<string> {
  requireTrackBPlan(plan);
  const findingDelivery = plan.findingDelivery!;
  const preregistrationSha256 = plan.preregistrationSha256!;
  const registration = admission.registration;
  const registrationBytes = admission.registrationBytes;
  const registrationSha256 = findingDeliveryArtifactSha256(registrationBytes);
  const timestamp = new Date().toISOString();
  const events: Array<Record<string, unknown>> = [{
    seq: 1,
    kind: "finding_registered",
    finding_id: registration.finding_id,
    finding_sha256: registration.finding_sha256,
    registration_sha256: registrationSha256,
  }];
  if (outcome.kind === "delivered") {
    if (outcome.evidence === null) {
      throw new ConfigurationError(
        "provider-zero delivered outcome is missing exact evidence",
      );
    }
    events.push({
      seq: 2,
      kind: "semantic_input",
      finding_id: registration.finding_id,
      finding_sha256: registration.finding_sha256,
      registration_sha256: registrationSha256,
      turn_id: outcome.evidence.turn_id,
      transport_event_id: outcome.evidence.transport_event_id,
      input_packet_sha256: outcome.evidence.input_packet_sha256,
      surface: outcome.evidence.surface,
    });
  }
  if (outcome.kind !== "unknown") {
    events.push({
      seq: events.length + 1,
      kind: "target_terminal",
      terminal_state: "completed",
    });
  }
  const lifecycle: FindingDeliveryLifecycle = findingDeliveryLifecycleSchema.parse({
    schema: "organum-code/finding-delivery-lifecycle/v1",
    producer_revision: producerRevision,
    run_id: plan.runID,
    target: registration.target,
    status: outcome.kind === "unknown" ? "incomplete" : "complete",
    incomplete_reason: outcome.kind === "unknown"
      ? "producer_state_incomplete"
      : null,
    events,
    finalized_at: timestamp,
  });
  const lifecycleBytes = canonicalJsonBytes(lifecycle);
  const lifecycleSha256 = findingDeliveryArtifactSha256(lifecycleBytes);
  const transportEventID = outcome.evidence?.transport_event_id ?? null;
  const dedupKey = sha256([
    "organum-code/finding-delivery-dedup/v1",
    plan.runID,
    registration.finding_id,
    registration.target.lane_id,
    idempotencyKey,
  ].join("\0"));
  let receiptInput: Record<string, unknown>;
  const common = {
    schema: "organum-code/finding-delivery-receipt/v1",
    producer_revision: producerRevision,
    run_id: plan.runID,
    finding_id: registration.finding_id,
    finding_sha256: registration.finding_sha256,
    target: registration.target,
    route: {
      channel: registration.route.channel,
      route_id: registration.route.route_id,
      transport_event_id: transportEventID,
      dedup_key: dedupKey,
    },
    registration_sha256: registrationSha256,
    lifecycle_ledger_sha256: lifecycleSha256,
    registered_seq: 1,
    emitted_at: timestamp,
  };
  if (outcome.kind === "delivered") {
    const evidence = outcome.evidence!;
    receiptInput = {
      ...common,
      outcome: "delivered",
      delivery: {
        semantic_input_seq: 2,
        turn_id: evidence.turn_id,
        transport_event_id: evidence.transport_event_id,
        input_packet_sha256: evidence.input_packet_sha256,
        surface: evidence.surface,
      },
      terminal_seq: 3,
      reason: null,
    };
  } else if (outcome.kind === "not_delivered") {
    receiptInput = {
      ...common,
      outcome: "not_delivered",
      delivery: null,
      terminal_seq: 2,
      reason: plan.arm === "bare"
        ? "no_coordination_channel"
        : "no_semantic_input_before_terminal",
    };
  } else {
    receiptInput = {
      ...common,
      outcome: "unknown",
      delivery: null,
      terminal_seq: null,
      reason: "producer_state_incomplete",
    };
  }
  const receipt: FindingDeliveryReceipt = findingDeliveryReceiptSchema.parse(
    receiptInput,
  );
  const receiptBytes = canonicalJsonBytes(receipt);

  const root = join(plan.stateDirectory, "finding-delivery");
  const laneRoot = join(root, registration.target.lane_id);
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(laneRoot);
  const registrationRelative =
    `state/finding-delivery/${registration.target.lane_id}/${registration.finding_id}.registration.json`;
  const receiptRelative =
    `state/finding-delivery/${registration.target.lane_id}/${registration.finding_id}.receipt.json`;
  const lifecycleRelative =
    `state/finding-delivery/${registration.target.lane_id}/lifecycle.json`;
  await writeExactPrivate(
    join(plan.runDirectory, registrationRelative),
    registrationBytes,
  );
  await writeExactPrivate(
    join(plan.runDirectory, receiptRelative),
    receiptBytes,
  );
  await writeExactPrivate(
    join(plan.runDirectory, lifecycleRelative),
    lifecycleBytes,
  );
  const binding = findingDeliveryCastBindingSchema.parse({
    schema: "organum-code/finding-delivery-cast-binding/v1",
    producer_revision: producerRevision,
    run_id: plan.runID,
    manifest_sha256: plan.manifestSha256,
    preregistration_sha256: preregistrationSha256,
    contract: findingDelivery.contract,
    route: findingDelivery.route,
    registrations: [{
      path: registrationRelative,
      sha256: findingDeliveryArtifactSha256(registrationBytes),
      finding_id: registration.finding_id,
      lane_id: registration.target.lane_id,
    }],
    receipts: [{
      path: receiptRelative,
      sha256: findingDeliveryArtifactSha256(receiptBytes),
      finding_id: registration.finding_id,
      lane_id: registration.target.lane_id,
    }],
    lifecycles: [{
      path: lifecycleRelative,
      sha256: findingDeliveryArtifactSha256(lifecycleBytes),
      lane_id: registration.target.lane_id,
    }],
  });
  const castResult = canonicalJsonBytes({
    schema: ORGANISM_CAST_RESULT_SCHEMA_V3,
    run_id: plan.runID,
    arm: plan.arm,
    manifest_sha256: plan.manifestSha256,
    finding_delivery: binding,
  });
  await writeExactPrivate(plan.resultPath, castResult);
  return findingDeliveryArtifactSha256(castResult);
}

export async function startOrganismCastProviderZero(
  stateRoot: string,
  producerRevision: string,
  rawRequest: unknown,
  privateFrames: Buffer,
  fault: OrganismCastProviderZeroFault,
): Promise<StartExecution> {
  await ensurePrivateDirectory(stateRoot);
  const request = organismCastStartRequestSchema.parse(rawRequest);
  const privateInput = decodeOrganismCastStartPrivateFrames(privateFrames);
  const privateManifestPath = join(
    stateRoot,
    request.prepare_id,
    "manifest.json",
  );
  const plan = await loadOrganismCastPlan(privateManifestPath);
  requireTrackBPlan(plan);
  if (
    plan.arm === "bare" &&
    (fault === "network" ||
      fault === "non-2xx" ||
      fault === "durability-gap")
  ) {
    throw new ConfigurationError(
      "provider fault modes requiring a semantic packet are invalid for bare",
    );
  }
  const release = await acquireLock(join(stateRoot, ".provider-zero-adapter.lock"));
  try {
    const existing = await readObservation(stateRoot);
    if (existing === null) {
      throw new ConfigurationError(
        "cast supervisor start requires its durable prepare observation",
      );
    }
    assertObservationIdentity(existing, {
      producerRevision,
      runID: request.run_id,
      arm: request.arm,
      prepareID: request.prepare_id,
    });
    const observation = organismCastProviderZeroObservationSchema.parse({
      ...existing,
      idempotency_key: request.idempotency_key,
      fault_mode: fault,
      start_call_count: existing.start_call_count + 1,
      receipt_emitted: false,
      recorded_at: new Date().toISOString(),
    });
    const boundary = new FindingDeliveryBrokerBoundary({
      async prepare({ body }) {
        return { ...body };
      },
      async accepted() {
        observation.semantic_persist_attempt_count += 1;
        if (fault === "durability-gap") {
          throw new Error("provider-zero semantic persistence fault");
        }
      },
      async complete() {},
    });
    const admit = organismCastFindingPacketAdmission(boundary);
    const supervisor = new OrganismCastV3Supervisor(stateRoot, {
      producerRevision,
      admitFindingPacket(admission) {
        observation.packet_admission_count += 1;
        admit(admission);
      },
      async launch(admission) {
        observation.launch_attempt_count += 1;
        if (fault === "ambiguous-launch") {
          throw new Error("provider-zero ambiguous launch fault");
        }
        const outcome: ProviderZeroOutcome = admission.packet === null
          ? { kind: "not_delivered", evidence: null }
          : await runProviderZeroBoundary(boundary, fault, observation);
        observation.cast_result_sha256 = await finalizeFindingDelivery(
          plan,
          producerRevision,
          admission,
          request.idempotency_key,
          outcome,
        );
      },
    });
    let receipt: OrganismCastStartReceipt;
    try {
      receipt = await supervisor.start(request, privateInput);
    } catch (error) {
      if (
        error instanceof Error &&
        /launch outcome is unknown|outcome is incomplete/.test(error.message)
      ) {
        observation.durable_phase = "incomplete";
      }
      observation.recorded_at = new Date().toISOString();
      await writeObservation(stateRoot, observation);
      throw error;
    }
    observation.durable_phase = "started";
    if (observation.cast_result_sha256 === null) {
      const castResult = await readFile(plan.resultPath).catch(() => null);
      if (castResult === null) {
        throw new ConfigurationError(
          "exact start retry is missing its durable v3 cast result",
        );
      }
      observation.cast_result_sha256 = findingDeliveryArtifactSha256(castResult);
    }
    const emitReceipt = fault !== "lost-response";
    observation.receipt_emitted = emitReceipt;
    observation.recorded_at = new Date().toISOString();
    await writeObservation(stateRoot, observation);
    return {
      receipt,
      observation: organismCastProviderZeroObservationSchema.parse(observation),
      emitReceipt,
    };
  } finally {
    await release();
  }
}

export async function runOrganismCastSupervisorCLI(
  args: readonly string[],
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
): Promise<number> {
  const command = parseCommand(args);
  const request = parseJson(await readBounded(stdin, MAX_CONTROL_BYTES));
  if (command.operation === "prepare") {
    const receipt = await prepareOrganismCastProviderZero(
      command.stateRoot,
      command.producerRevision,
      request,
    );
    stdout.write(canonicalJsonBytes(receipt));
    return 0;
  }
  const privateStream = createReadStream("", {
    fd: command.privateInputFD!,
    autoClose: true,
  });
  const privateFrames = await readBounded(
    privateStream,
    MAX_PRIVATE_FRAME_BYTES,
  );
  const execution = await startOrganismCastProviderZero(
    command.stateRoot,
    command.producerRevision,
    request,
    privateFrames,
    command.fault,
  );
  if (execution.emitReceipt) {
    stdout.write(canonicalJsonBytes(execution.receipt));
    return 0;
  }
  return 3;
}

export function organismCastProviderZeroObservationStructuralJSONSchema(): Record<
  string,
  unknown
> {
  const generated = z.toJSONSchema(
    organismCastProviderZeroObservationSchema,
    { target: "draft-2020-12" },
  );
  const { $schema, ...shape } = generated;
  return {
    $schema,
    $id: ORGANISM_CAST_PROVIDER_ZERO_OBSERVATION_JSON_SCHEMA_ID,
    $comment:
      "Provider-zero diagnostic evidence only; never launch authority or a finding-delivery receipt.",
    ...shape,
  };
}
