import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import {
  canonicalFindingDeliverySemanticInputPacketBytes,
  findingDeliveryArtifactSha256,
  findingDeliveryRegistrationSchema,
  findingDeliverySemanticInputPacketSchema,
  prepareFindingDeliverySemanticInputPacket,
  type PreparedFindingDeliverySemanticInputPacket,
} from "./finding-delivery.js";
import type {
  FindingDeliveryBrokerBoundary,
} from "./finding-delivery-broker-boundary.js";
import {
  loadOrganismCastPlan,
  ORGANISM_CAST_MANIFEST_SCHEMA,
  ORGANISM_CAST_MANIFEST_SCHEMA_V3,
  type OrganismCastArm,
  type OrganismCastPlan,
} from "./organism-cast.js";
import { ConfigurationError } from "./provider-profile.js";

export const ORGANISM_CAST_PREPARE_REQUEST_SCHEMA =
  "organum-code/organism-cast-prepare-request/v1" as const;
export const ORGANISM_CAST_PREPARE_RECEIPT_SCHEMA =
  "organum-code/organism-cast-prepare-receipt/v1" as const;
export const ORGANISM_CAST_START_REQUEST_SCHEMA =
  "organum-code/organism-cast-start-request/v1" as const;
export const ORGANISM_CAST_START_RECEIPT_SCHEMA =
  "organum-code/organism-cast-start-receipt/v1" as const;

export const ORGANISM_CAST_PREPARE_REQUEST_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-organism-cast-prepare-request-v1.schema.json" as const;
export const ORGANISM_CAST_PREPARE_RECEIPT_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-organism-cast-prepare-receipt-v1.schema.json" as const;
export const ORGANISM_CAST_START_REQUEST_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-organism-cast-start-request-v1.schema.json" as const;
export const ORGANISM_CAST_START_RECEIPT_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-organism-cast-start-receipt-v1.schema.json" as const;

const PREPARED_STATE_SCHEMA =
  "organum-code/organism-cast-prepared-state/v1" as const;
const RUNTIME_STATE_SCHEMA =
  "organum-code/organism-cast-runtime-state/v1" as const;
const WORKING_LIFECYCLE_SCHEMA =
  "organum-code/finding-delivery-working/v1" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PREPARE_ID_PATTERN = /^prepare-[0-9a-f]{32}$/;
const SAFE_RELATIVE_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,1022}[A-Za-z0-9])?$/;
const MAX_CONTROL_BYTES = 128 * 1024;
const MAX_REGISTRATION_BYTES = 128 * 1024;
const MAX_PACKET_BYTES = 16 * 1024;
const LOCK_ATTEMPTS = 2_000;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const producerRevisionSchema = z.string().regex(GIT_COMMIT_PATTERN);
const runIDSchema = z.string().regex(RUN_ID_PATTERN);
const prepareIDSchema = z.string().regex(PREPARE_ID_PATTERN);
const armSchema = z.enum(["organum", "bare"]);

const absoluteFileReferenceSchema = z.object({
  path: z.string().min(1).max(4_096),
  sha256: sha256Schema,
}).strict();

const privateFileReferenceSchema = z.object({
  path: z.string().min(1).max(1_024).regex(SAFE_RELATIVE_PATH_PATTERN),
  sha256: sha256Schema,
}).strict();

export const organismCastPrepareRequestSchema = z.object({
  schema: z.literal(ORGANISM_CAST_PREPARE_REQUEST_SCHEMA),
  run_id: runIDSchema,
  arm: armSchema,
  manifest: absoluteFileReferenceSchema,
  preregistration: absoluteFileReferenceSchema,
}).strict();

export const organismCastPrepareReceiptSchema = z.object({
  schema: z.literal(ORGANISM_CAST_PREPARE_RECEIPT_SCHEMA),
  producer_revision: producerRevisionSchema,
  prepare_id: prepareIDSchema,
  run_id: runIDSchema,
  arm: armSchema,
  phase: z.literal("prepared"),
  manifest: privateFileReferenceSchema,
  preregistration: privateFileReferenceSchema,
  prepared_state_sha256: sha256Schema,
  launch_count: z.literal(0),
  actor_process_count: z.literal(0),
  backend_process_count: z.literal(0),
  provider_request_count: z.literal(0),
}).strict();

export const organismCastStartRequestSchema = z.object({
  schema: z.literal(ORGANISM_CAST_START_REQUEST_SCHEMA),
  prepare_id: prepareIDSchema,
  run_id: runIDSchema,
  arm: armSchema,
  manifest_sha256: sha256Schema,
  preregistration_sha256: sha256Schema,
  prepared_state_sha256: sha256Schema,
  registration_sha256: sha256Schema,
  pending_packet_sha256: sha256Schema.nullable(),
  idempotency_key: sha256Schema,
}).strict().superRefine((request, context) => {
  if (
    (request.arm === "organum" && request.pending_packet_sha256 === null) ||
    (request.arm === "bare" && request.pending_packet_sha256 !== null)
  ) {
    context.addIssue({
      code: "custom",
      path: ["pending_packet_sha256"],
      message: "organum requires a pending packet digest and bare requires null",
    });
  }
});

export const organismCastStartReceiptSchema = z.object({
  schema: z.literal(ORGANISM_CAST_START_RECEIPT_SCHEMA),
  producer_revision: producerRevisionSchema,
  prepare_id: prepareIDSchema,
  run_id: runIDSchema,
  arm: armSchema,
  phase: z.literal("started"),
  manifest: privateFileReferenceSchema,
  preregistration: privateFileReferenceSchema,
  prepared_state_sha256: sha256Schema,
  registration_sha256: sha256Schema,
  pending_packet_sha256: sha256Schema.nullable(),
  launch_count: z.literal(1),
  idempotency_key: sha256Schema,
}).strict();

const preparedStateSchema = z.object({
  schema: z.literal(PREPARED_STATE_SCHEMA),
  producer_revision: producerRevisionSchema,
  prepare_id: prepareIDSchema,
  run_id: runIDSchema,
  arm: armSchema,
  manifest: privateFileReferenceSchema,
  preregistration: privateFileReferenceSchema,
}).strict();

const runtimeStateSchema = z.object({
  schema: z.literal(RUNTIME_STATE_SCHEMA),
  prepare_id: prepareIDSchema,
  phase: z.enum(["prepared", "starting", "started", "incomplete"]),
  prepared_state_sha256: sha256Schema,
  launch_count: z.union([z.literal(0), z.literal(1)]),
  idempotency_key: sha256Schema.nullable(),
  registration_sha256: sha256Schema.nullable(),
  pending_packet_sha256: sha256Schema.nullable(),
  incomplete_reason: z.enum(["launch_outcome_unknown"]).nullable(),
}).strict();

export type OrganismCastPrepareRequest = z.infer<
  typeof organismCastPrepareRequestSchema
>;
export type OrganismCastPrepareReceipt = z.infer<
  typeof organismCastPrepareReceiptSchema
>;
export type OrganismCastStartRequest = z.infer<
  typeof organismCastStartRequestSchema
>;
export type OrganismCastStartReceipt = z.infer<
  typeof organismCastStartReceiptSchema
>;

export interface OrganismCastStartPrivateInput {
  registrationBytes: Buffer;
  packetBytes: Buffer | null;
}

export interface OrganismCastAcceptedAdmission {
  plan: OrganismCastPlan;
  registration: z.infer<typeof findingDeliveryRegistrationSchema>;
  registrationBytes: Buffer;
  packet: PreparedFindingDeliverySemanticInputPacket | null;
}

export interface OrganismCastSupervisorDependencies {
  producerRevision: string;
  admitFindingPacket?: (
    admission: OrganismCastAcceptedAdmission,
  ) => void | Promise<void>;
  launch: (
    admission: OrganismCastAcceptedAdmission,
  ) => void | Promise<void>;
}

export function organismCastFindingPacketAdmission(
  boundary: FindingDeliveryBrokerBoundary,
): NonNullable<OrganismCastSupervisorDependencies["admitFindingPacket"]> {
  return (admission) => {
    if (admission.packet === null) {
      throw new ConfigurationError(
        "Bare admission must not be sent to the finding broker boundary",
      );
    }
    const enqueued = boundary.enqueue({
      run_id: admission.packet.packet.run_id,
      finding_id: admission.packet.packet.finding_id,
      action_token: admission.packet.packet.action_token,
      target_lane_id: admission.registration.target.lane_id,
    });
    if (
      enqueued.sha256 !== admission.packet.sha256 ||
      !enqueued.bytes.equals(admission.packet.bytes)
    ) {
      throw new ConfigurationError(
        "Finding broker admission changed the prepared semantic-input packet",
      );
    }
  };
}

interface StatePaths {
  directory: string;
  manifest: string;
  preregistration: string;
  prepared: string;
  prepareReceipt: string;
  runtime: string;
  registration: string;
  packet: string;
  workingLifecycle: string;
  startReceipt: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function statePaths(root: string, prepareID: string): StatePaths {
  const directory = join(root, prepareID);
  return {
    directory,
    manifest: join(directory, "manifest.json"),
    preregistration: join(directory, "preregistration.json"),
    prepared: join(directory, "prepared-state.json"),
    prepareReceipt: join(directory, "prepare-receipt.json"),
    runtime: join(directory, "runtime-state.json"),
    registration: join(directory, "registration.json"),
    packet: join(directory, "pending-packet.json"),
    workingLifecycle: join(directory, "finding-lifecycle-working.json"),
    startReceipt: join(directory, "start-receipt.json"),
  };
}

function relativeStatePath(prepareID: string, filename: string): string {
  return `${prepareID}/${filename}`;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
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
      "Organism cast supervisor state must be a private real directory",
    );
  }
}

async function boundedRegularFile(
  path: string,
  maximumBytes: number,
  context: string,
): Promise<{ canonicalPath: string; bytes: Buffer }> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ConfigurationError(`${context} must be an absolute path`);
  }
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > maximumBytes
  ) {
    throw new ConfigurationError(
      `${context} must be a bounded regular non-symlink file`,
    );
  }
  const canonicalPath = await realpath(path);
  return { canonicalPath, bytes: await readFile(canonicalPath) };
}

async function atomicWritePrivate(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.${createHash("sha256")
    .update(`${Date.now()}\0${Math.random()}`)
    .digest("hex")
    .slice(0, 12)}.tmp`;
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

async function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_CONTROL_BYTES) {
    throw new ConfigurationError("Organism cast supervisor state is oversized");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ConfigurationError("Organism cast supervisor state is invalid JSON");
  }
  return schema.parse(decoded);
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      return async () => {
        await rmdir(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2));
    }
  }
  throw new ConfigurationError("Organism cast supervisor lock timed out");
}

function prepareIDForRun(runID: string): string {
  return `prepare-${sha256(
    `organum-code/organism-cast-prepare-id/v1\0${runID}`,
  ).slice(0, 32)}`;
}

export function organismCastStartIdempotencyKey(
  request: Omit<OrganismCastStartRequest, "idempotency_key">,
): string {
  const pending = request.pending_packet_sha256 ?? "bare:none";
  return sha256([
    "organum-code/organism-cast-start-idempotency/v1",
    request.schema,
    request.prepare_id,
    request.run_id,
    request.arm,
    request.manifest_sha256,
    request.preregistration_sha256,
    request.prepared_state_sha256,
    request.registration_sha256,
    pending,
  ].join("\0"));
}

export function decodeOrganismCastStartPrivateFrames(
  framed: Buffer,
): OrganismCastStartPrivateInput {
  if (framed.length < 8) {
    throw new ConfigurationError("Organism cast private input frame is truncated");
  }
  const registrationLength = framed.readUInt32BE(0);
  if (
    registrationLength < 1 ||
    registrationLength > MAX_REGISTRATION_BYTES ||
    framed.length < 8 + registrationLength
  ) {
    throw new ConfigurationError("Organism cast registration frame is invalid");
  }
  const registrationStart = 4;
  const registrationEnd = registrationStart + registrationLength;
  const packetLength = framed.readUInt32BE(registrationEnd);
  if (
    packetLength > MAX_PACKET_BYTES ||
    framed.length !== registrationEnd + 4 + packetLength
  ) {
    throw new ConfigurationError(
      "Organism cast packet frame or exact EOF is invalid",
    );
  }
  return {
    registrationBytes: Buffer.from(
      framed.subarray(registrationStart, registrationEnd),
    ),
    packetBytes: packetLength === 0
      ? null
      : Buffer.from(framed.subarray(registrationEnd + 4)),
  };
}

function validatePrivateAdmission(
  plan: OrganismCastPlan,
  request: OrganismCastStartRequest,
  input: OrganismCastStartPrivateInput,
): OrganismCastAcceptedAdmission {
  if (
    !Buffer.isBuffer(input.registrationBytes) ||
    input.registrationBytes.length < 1 ||
    input.registrationBytes.length > MAX_REGISTRATION_BYTES ||
    findingDeliveryArtifactSha256(input.registrationBytes) !==
      request.registration_sha256
  ) {
    throw new ConfigurationError(
      "Organism cast registration bytes do not match the start request",
    );
  }
  let registrationDecoded: unknown;
  try {
    registrationDecoded = JSON.parse(input.registrationBytes.toString("utf8"));
  } catch {
    throw new ConfigurationError("Organism cast registration is invalid JSON");
  }
  const registration = findingDeliveryRegistrationSchema.parse(
    registrationDecoded,
  );
  const lane = plan.lanes.find(
    (candidate) => candidate.id === registration.target.lane_id,
  );
  const expectedChannel = plan.arm === "organum"
    ? "organum_coordination"
    : "bare_no_coordination";
  if (
    registration.run_id !== plan.runID ||
    lane === undefined ||
    lane.actor !== registration.target.actor_id ||
    registration.route.channel !== expectedChannel
  ) {
    throw new ConfigurationError(
      "Organism cast registration does not match the prepared run, target, or route",
    );
  }

  if (plan.arm === "bare") {
    if (input.packetBytes !== null) {
      throw new ConfigurationError("Bare start must not carry packet bytes");
    }
    return {
      plan,
      registration,
      registrationBytes: Buffer.from(input.registrationBytes),
      packet: null,
    };
  }

  if (
    !Buffer.isBuffer(input.packetBytes) ||
    input.packetBytes.length < 1 ||
    input.packetBytes.length > MAX_PACKET_BYTES ||
    request.pending_packet_sha256 === null ||
    findingDeliveryArtifactSha256(input.packetBytes) !==
      request.pending_packet_sha256
  ) {
    throw new ConfigurationError(
      "Organum start packet bytes do not match the start request",
    );
  }
  let packetDecoded: unknown;
  try {
    packetDecoded = JSON.parse(input.packetBytes.toString("utf8"));
  } catch {
    throw new ConfigurationError("Organum cast packet is invalid JSON");
  }
  const packet = findingDeliverySemanticInputPacketSchema.parse(packetDecoded);
  const canonical = canonicalFindingDeliverySemanticInputPacketBytes(packet);
  if (
    !canonical.equals(input.packetBytes) ||
    packet.run_id !== registration.run_id ||
    packet.finding_id !== registration.finding_id
  ) {
    throw new ConfigurationError(
      "Organum cast packet is noncanonical or does not match the registration",
    );
  }
  const preparedPacket = prepareFindingDeliverySemanticInputPacket(packet);
  if (preparedPacket.sha256 !== request.pending_packet_sha256) {
    throw new ConfigurationError("Organum cast packet digest is inconsistent");
  }
  return {
    plan,
    registration,
    registrationBytes: Buffer.from(input.registrationBytes),
    packet: preparedPacket,
  };
}

export class OrganismCastV3Supervisor {
  readonly #root: string;
  readonly #producerRevision: string;
  readonly #admitFindingPacket:
    | OrganismCastSupervisorDependencies["admitFindingPacket"];
  readonly #launch: OrganismCastSupervisorDependencies["launch"];

  constructor(
    stateRoot: string,
    dependencies: OrganismCastSupervisorDependencies,
  ) {
    if (!isAbsolute(stateRoot) || stateRoot.includes("\0")) {
      throw new ConfigurationError(
        "Organism cast supervisor state root must be absolute",
      );
    }
    this.#root = resolve(stateRoot);
    this.#producerRevision = producerRevisionSchema.parse(
      dependencies.producerRevision,
    );
    this.#admitFindingPacket = dependencies.admitFindingPacket;
    this.#launch = dependencies.launch;
  }

  async prepare(rawRequest: unknown): Promise<OrganismCastPrepareReceipt> {
    const request = organismCastPrepareRequestSchema.parse(rawRequest);
    await ensurePrivateDirectory(this.#root);
    const manifest = await boundedRegularFile(
      request.manifest.path,
      MAX_CONTROL_BYTES,
      "Organism cast prepare manifest",
    );
    const preregistration = await boundedRegularFile(
      request.preregistration.path,
      MAX_CONTROL_BYTES,
      "Organism cast prepare preregistration",
    );
    if (
      sha256(manifest.bytes) !== request.manifest.sha256 ||
      sha256(preregistration.bytes) !== request.preregistration.sha256
    ) {
      throw new ConfigurationError(
        "Organism cast prepare request digest does not match its raw bytes",
      );
    }
    const plan = await loadOrganismCastPlan(manifest.canonicalPath);
    if (
      (plan.schema !== ORGANISM_CAST_MANIFEST_SCHEMA &&
        plan.schema !== ORGANISM_CAST_MANIFEST_SCHEMA_V3) ||
      plan.runID !== request.run_id ||
      plan.arm !== request.arm ||
      plan.manifestSha256 !== request.manifest.sha256 ||
      plan.preregistrationPath !== preregistration.canonicalPath ||
      plan.preregistrationSha256 !== request.preregistration.sha256
    ) {
      throw new ConfigurationError(
        "Organism cast prepare request does not match the validated plan",
      );
    }
    if (plan.arm === "organum" && plan.deliveryGate === null) {
      throw new ConfigurationError(
        "Organum cast prepare requires a provider-zero-qualified delivery gate",
      );
    }
    if (
      inside(plan.runDirectory, this.#root) ||
      inside(this.#root, plan.runDirectory) ||
      inside(plan.workDirectory, this.#root) ||
      inside(this.#root, plan.workDirectory) ||
      inside(plan.stateDirectory, this.#root) ||
      inside(this.#root, plan.stateDirectory)
    ) {
      throw new ConfigurationError(
        "Organism cast supervisor state must be disjoint from actor-visible run state",
      );
    }

    const prepareID = prepareIDForRun(plan.runID);
    const paths = statePaths(this.#root, prepareID);
    const release = await acquireLock(join(this.#root, `${prepareID}.lock`));
    try {
      const existing = await readJsonFile(
        paths.prepareReceipt,
        organismCastPrepareReceiptSchema,
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (existing !== null) {
        if (
          existing.producer_revision !== this.#producerRevision ||
          existing.run_id !== request.run_id ||
          existing.arm !== request.arm ||
          existing.manifest.sha256 !== request.manifest.sha256 ||
          existing.preregistration.sha256 !== request.preregistration.sha256
        ) {
          throw new ConfigurationError(
            "Conflicting prepare bytes share one run identity",
          );
        }
        return existing;
      }

      await ensurePrivateDirectory(paths.directory);
      if (!inside(this.#root, paths.directory)) {
        throw new ConfigurationError("Organism cast prepare path escaped state root");
      }
      await atomicWritePrivate(paths.manifest, manifest.bytes);
      await atomicWritePrivate(paths.preregistration, preregistration.bytes);
      const manifestReference = {
        path: relativeStatePath(prepareID, "manifest.json"),
        sha256: request.manifest.sha256,
      };
      const preregistrationReference = {
        path: relativeStatePath(prepareID, "preregistration.json"),
        sha256: request.preregistration.sha256,
      };
      const preparedState = preparedStateSchema.parse({
        schema: PREPARED_STATE_SCHEMA,
        producer_revision: this.#producerRevision,
        prepare_id: prepareID,
        run_id: plan.runID,
        arm: plan.arm,
        manifest: manifestReference,
        preregistration: preregistrationReference,
      });
      const preparedBytes = canonicalJsonBytes(preparedState);
      const preparedStateSha256 = sha256(preparedBytes);
      await atomicWritePrivate(paths.prepared, preparedBytes);
      await atomicWritePrivate(paths.runtime, canonicalJsonBytes(
        runtimeStateSchema.parse({
          schema: RUNTIME_STATE_SCHEMA,
          prepare_id: prepareID,
          phase: "prepared",
          prepared_state_sha256: preparedStateSha256,
          launch_count: 0,
          idempotency_key: null,
          registration_sha256: null,
          pending_packet_sha256: null,
          incomplete_reason: null,
        }),
      ));
      const receipt = organismCastPrepareReceiptSchema.parse({
        schema: ORGANISM_CAST_PREPARE_RECEIPT_SCHEMA,
        producer_revision: this.#producerRevision,
        prepare_id: prepareID,
        run_id: plan.runID,
        arm: plan.arm,
        phase: "prepared",
        manifest: manifestReference,
        preregistration: preregistrationReference,
        prepared_state_sha256: preparedStateSha256,
        launch_count: 0,
        actor_process_count: 0,
        backend_process_count: 0,
        provider_request_count: 0,
      });
      await atomicWritePrivate(paths.prepareReceipt, canonicalJsonBytes(receipt));
      return receipt;
    } finally {
      await release();
    }
  }

  async start(
    rawRequest: unknown,
    privateInput: OrganismCastStartPrivateInput,
  ): Promise<OrganismCastStartReceipt> {
    const request = organismCastStartRequestSchema.parse(rawRequest);
    const expectedIdempotency = organismCastStartIdempotencyKey({
      schema: request.schema,
      prepare_id: request.prepare_id,
      run_id: request.run_id,
      arm: request.arm,
      manifest_sha256: request.manifest_sha256,
      preregistration_sha256: request.preregistration_sha256,
      prepared_state_sha256: request.prepared_state_sha256,
      registration_sha256: request.registration_sha256,
      pending_packet_sha256: request.pending_packet_sha256,
    });
    if (request.idempotency_key !== expectedIdempotency) {
      throw new ConfigurationError(
        "Organism cast start idempotency key does not match its bindings",
      );
    }
    await ensurePrivateDirectory(this.#root);
    const paths = statePaths(this.#root, request.prepare_id);
    if (!inside(this.#root, paths.directory)) {
      throw new ConfigurationError("Organism cast start path escaped state root");
    }
    const release = await acquireLock(
      join(this.#root, `${request.prepare_id}.lock`),
    );
    try {
      const prepareReceipt = await readJsonFile(
        paths.prepareReceipt,
        organismCastPrepareReceiptSchema,
      );
      const preparedBytes = await readFile(paths.prepared);
      const preparedState = preparedStateSchema.parse(
        JSON.parse(preparedBytes.toString("utf8")),
      );
      let runtime = await readJsonFile(paths.runtime, runtimeStateSchema);
      if (
        prepareReceipt.producer_revision !== this.#producerRevision ||
        prepareReceipt.prepare_id !== request.prepare_id ||
        prepareReceipt.run_id !== request.run_id ||
        prepareReceipt.arm !== request.arm ||
        prepareReceipt.manifest.sha256 !== request.manifest_sha256 ||
        prepareReceipt.preregistration.sha256 !==
          request.preregistration_sha256 ||
        prepareReceipt.prepared_state_sha256 !==
          request.prepared_state_sha256 ||
        sha256(preparedBytes) !== request.prepared_state_sha256 ||
        preparedState.prepare_id !== request.prepare_id ||
        runtime.prepared_state_sha256 !== request.prepared_state_sha256
      ) {
        throw new ConfigurationError(
          "Organism cast start does not match immutable prepared state",
        );
      }

      if (runtime.phase === "started") {
        if (runtime.idempotency_key !== request.idempotency_key) {
          throw new ConfigurationError(
            "Conflicting start request shares one prepared identity",
          );
        }
        return await readJsonFile(
          paths.startReceipt,
          organismCastStartReceiptSchema,
        );
      }
      if (runtime.phase === "starting" || runtime.phase === "incomplete") {
        throw new ConfigurationError(
          "Organism cast launch outcome is incomplete; automatic relaunch is forbidden",
        );
      }
      if (
        runtime.idempotency_key !== null &&
        runtime.idempotency_key !== request.idempotency_key
      ) {
        throw new ConfigurationError(
          "Conflicting start request shares one prepared identity",
        );
      }

      const manifestPath = join(this.#root, prepareReceipt.manifest.path);
      const preregistrationPath = join(
        this.#root,
        prepareReceipt.preregistration.path,
      );
      if (
        !inside(paths.directory, manifestPath) ||
        !inside(paths.directory, preregistrationPath)
      ) {
        throw new ConfigurationError(
          "Organism cast private prepared references escaped their state directory",
        );
      }
      const manifestBytes = await readFile(manifestPath);
      const preregistrationBytes = await readFile(preregistrationPath);
      if (
        sha256(manifestBytes) !== request.manifest_sha256 ||
        sha256(preregistrationBytes) !== request.preregistration_sha256
      ) {
        throw new ConfigurationError(
          "Organism cast private prepared bytes changed after prepare",
        );
      }
      const plan = await loadOrganismCastPlan(manifestPath);
      if (
        plan.runID !== request.run_id ||
        plan.arm !== request.arm ||
        plan.manifestSha256 !== request.manifest_sha256 ||
        plan.preregistrationSha256 !== request.preregistration_sha256
      ) {
        throw new ConfigurationError(
          "Organism cast revalidated plan differs from the start request",
        );
      }
      const admission = validatePrivateAdmission(plan, request, privateInput);

      runtime = runtimeStateSchema.parse({
        ...runtime,
        idempotency_key: request.idempotency_key,
        registration_sha256: request.registration_sha256,
        pending_packet_sha256: request.pending_packet_sha256,
      });
      await atomicWritePrivate(paths.registration, admission.registrationBytes);
      if (admission.packet !== null) {
        await atomicWritePrivate(paths.packet, admission.packet.bytes);
      }
      await atomicWritePrivate(paths.workingLifecycle, canonicalJsonBytes({
        schema: WORKING_LIFECYCLE_SCHEMA,
        producer_revision: this.#producerRevision,
        run_id: plan.runID,
        target: admission.registration.target,
        events: [{
          seq: 1,
          kind: "finding_registered",
          finding_id: admission.registration.finding_id,
          finding_sha256: admission.registration.finding_sha256,
          registration_sha256: request.registration_sha256,
        }],
      }));
      await atomicWritePrivate(paths.runtime, canonicalJsonBytes(runtime));

      if (admission.packet !== null) {
        if (this.#admitFindingPacket === undefined) {
          throw new ConfigurationError(
            "Organum start requires a producer finding-packet admission boundary",
          );
        }
        await this.#admitFindingPacket(admission);
      }

      runtime = runtimeStateSchema.parse({
        ...runtime,
        phase: "starting",
        launch_count: 1,
      });
      await atomicWritePrivate(paths.runtime, canonicalJsonBytes(runtime));
      try {
        await this.#launch(admission);
      } catch {
        runtime = runtimeStateSchema.parse({
          ...runtime,
          phase: "incomplete",
          incomplete_reason: "launch_outcome_unknown",
        });
        await atomicWritePrivate(paths.runtime, canonicalJsonBytes(runtime));
        throw new ConfigurationError(
          "Organism cast launch outcome is unknown; automatic relaunch is forbidden",
        );
      }

      runtime = runtimeStateSchema.parse({
        ...runtime,
        phase: "started",
      });
      await atomicWritePrivate(paths.runtime, canonicalJsonBytes(runtime));
      const receipt = organismCastStartReceiptSchema.parse({
        schema: ORGANISM_CAST_START_RECEIPT_SCHEMA,
        producer_revision: this.#producerRevision,
        prepare_id: request.prepare_id,
        run_id: request.run_id,
        arm: request.arm,
        phase: "started",
        manifest: prepareReceipt.manifest,
        preregistration: prepareReceipt.preregistration,
        prepared_state_sha256: request.prepared_state_sha256,
        registration_sha256: request.registration_sha256,
        pending_packet_sha256: request.pending_packet_sha256,
        launch_count: 1,
        idempotency_key: request.idempotency_key,
      });
      await atomicWritePrivate(paths.startReceipt, canonicalJsonBytes(receipt));
      return receipt;
    } finally {
      await release();
    }
  }
}

function structuralJSONSchema(
  schema: z.ZodType,
  id: string,
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, { target: "draft-2020-12" });
  const { $schema, ...shape } = generated;
  return {
    $schema,
    $id: id,
    $comment:
      "Structural projection. The Zod source and its cross-field refinements remain authoritative.",
    ...shape,
  };
}

export function organismCastPrepareRequestStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    organismCastPrepareRequestSchema,
    ORGANISM_CAST_PREPARE_REQUEST_JSON_SCHEMA_ID,
  );
}

export function organismCastPrepareReceiptStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    organismCastPrepareReceiptSchema,
    ORGANISM_CAST_PREPARE_RECEIPT_JSON_SCHEMA_ID,
  );
}

export function organismCastStartRequestStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    organismCastStartRequestSchema,
    ORGANISM_CAST_START_REQUEST_JSON_SCHEMA_ID,
  );
}

export function organismCastStartReceiptStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    organismCastStartReceiptSchema,
    ORGANISM_CAST_START_RECEIPT_JSON_SCHEMA_ID,
  );
}
