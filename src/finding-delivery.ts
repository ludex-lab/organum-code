import { createHash } from "node:crypto";

import { z } from "zod";

export const FINDING_DELIVERY_REGISTRATION_SCHEMA =
  "organum-code/finding-delivery-registration/v1" as const;
export const FINDING_DELIVERY_RECEIPT_SCHEMA =
  "organum-code/finding-delivery-receipt/v1" as const;
export const FINDING_DELIVERY_LIFECYCLE_SCHEMA =
  "organum-code/finding-delivery-lifecycle/v1" as const;
export const FINDING_DELIVERY_CAST_BINDING_SCHEMA =
  "organum-code/finding-delivery-cast-binding/v1" as const;
export const FINDING_DELIVERY_SEMANTIC_INPUT_SURFACE =
  "provider_semantic_input" as const;

export const FINDING_DELIVERY_REGISTRATION_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-finding-delivery-registration-v1.schema.json" as const;
export const FINDING_DELIVERY_RECEIPT_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-finding-delivery-receipt-v1.schema.json" as const;
export const FINDING_DELIVERY_LIFECYCLE_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-finding-delivery-lifecycle-v1.schema.json" as const;
export const FINDING_DELIVERY_CAST_BINDING_JSON_SCHEMA_ID =
  "https://organum.dev/schemas/organum-code-finding-delivery-cast-binding-v1.schema.json" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BOUNDED_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:@/-]{0,254}[A-Za-z0-9])?$/;
const ROUTE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const FINDING_ID_PATTERN = /^h-runaway-[0-9a-f]{64}$/;
const ACTION_TOKEN_PATTERN = /^[0-9a-f]{32,128}$/;
const RELATIVE_ARTIFACT_PATH_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,1022}[A-Za-z0-9])?$/;

const sha256Schema = z.string().regex(SHA256_PATTERN);
const gitCommitSchema = z.string().regex(GIT_COMMIT_PATTERN);
const runIDSchema = z.string().regex(RUN_ID_PATTERN);
const boundedIDSchema = z.string().regex(BOUNDED_ID_PATTERN);
const routeIDSchema = z.string().regex(ROUTE_ID_PATTERN);
const findingIDSchema = z.string().regex(FINDING_ID_PATTERN);
const actionTokenSchema = z.string().regex(ACTION_TOKEN_PATTERN);
const utcTimestampSchema = z.string().datetime();
const lifecycleSequenceSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const relativeArtifactPathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(RELATIVE_ARTIFACT_PATH_PATTERN);

export const findingDeliveryChannelSchema = z.enum([
  "organum_coordination",
  "bare_no_coordination",
]);

const findingIdentityShape = {
  finding_id: findingIDSchema,
  finding_sha256: sha256Schema,
} as const;

const targetSchema = z
  .object({
    lane_id: runIDSchema,
    actor_id: boundedIDSchema,
  })
  .strict();

const routePinSchema = z
  .object({
    channel: findingDeliveryChannelSchema,
    route_id: routeIDSchema,
  })
  .strict();

const routeEvidenceSchema = routePinSchema.extend({
  transport_event_id: boundedIDSchema.nullable(),
  dedup_key: sha256Schema,
});

export const findingDeliverySemanticInputPacketSchema = z
  .object({
    action_token: actionTokenSchema,
    finding_id: findingIDSchema,
    run_id: runIDSchema,
    surface: z.literal(FINDING_DELIVERY_SEMANTIC_INPUT_SURFACE),
  })
  .strict();

export type FindingDeliverySemanticInputPacket = z.infer<
  typeof findingDeliverySemanticInputPacketSchema
>;

export interface PreparedFindingDeliverySemanticInputPacket {
  packet: Readonly<FindingDeliverySemanticInputPacket>;
  bytes: Buffer;
  text: string;
  sha256: string;
}

export const FINDING_DELIVERY_SEMANTIC_INPUT_PACKET_VECTOR = Object.freeze({
  run_id: "pack-a-run-01",
  finding_id: `h-runaway-${"0".repeat(64)}`,
  action_token: "a".repeat(48),
  surface: FINDING_DELIVERY_SEMANTIC_INPUT_SURFACE,
  sha256: "150bdfed8449e293e3da896d44b1d8d655f910649c061c24a0dcf8674cd2b329",
});

/**
 * Jointly frozen with organum-bench: exact four-key, sorted-key compact JSON,
 * UTF-8, and no trailing newline.
 */
export function canonicalFindingDeliverySemanticInputPacketBytes(
  input: unknown,
): Buffer {
  const packet = findingDeliverySemanticInputPacketSchema.parse(input);
  return Buffer.from(JSON.stringify({
    action_token: packet.action_token,
    finding_id: packet.finding_id,
    run_id: packet.run_id,
    surface: packet.surface,
  }), "utf8");
}

export function prepareFindingDeliverySemanticInputPacket(input: {
  run_id: string;
  finding_id: string;
  action_token: string;
}): PreparedFindingDeliverySemanticInputPacket {
  const packet = Object.freeze(findingDeliverySemanticInputPacketSchema.parse({
    ...input,
    surface: FINDING_DELIVERY_SEMANTIC_INPUT_SURFACE,
  }));
  const bytes = canonicalFindingDeliverySemanticInputPacketBytes(packet);
  return {
    packet,
    bytes,
    text: bytes.toString("utf8"),
    sha256: findingDeliveryArtifactSha256(bytes),
  };
}

function addFindingIdentityIssue(
  finding: { finding_id: string; finding_sha256: string },
  context: z.RefinementCtx,
): void {
  if (finding.finding_id !== `h-runaway-${finding.finding_sha256}`) {
    context.addIssue({
      code: "custom",
      path: ["finding_id"],
      message: "finding_id must be h-runaway- followed by finding_sha256",
    });
  }
}

export const findingDeliveryRegistrationSchema = z
  .object({
    schema: z.literal(FINDING_DELIVERY_REGISTRATION_SCHEMA),
    run_id: runIDSchema,
    ...findingIdentityShape,
    hazard_id: z.literal("H-runaway"),
    target: targetSchema,
    route: routePinSchema,
    detected_at: utcTimestampSchema,
  })
  .strict()
  .superRefine(addFindingIdentityIssue);

const findingRegisteredEventSchema = z
  .object({
    seq: lifecycleSequenceSchema,
    kind: z.literal("finding_registered"),
    ...findingIdentityShape,
    registration_sha256: sha256Schema,
  })
  .strict();

const semanticInputEventSchema = z
  .object({
    seq: lifecycleSequenceSchema,
    kind: z.literal("semantic_input"),
    ...findingIdentityShape,
    registration_sha256: sha256Schema,
    turn_id: boundedIDSchema,
    transport_event_id: boundedIDSchema,
    input_packet_sha256: sha256Schema,
    surface: z.literal("provider_semantic_input"),
  })
  .strict();

const targetTerminalEventSchema = z
  .object({
    seq: lifecycleSequenceSchema,
    kind: z.literal("target_terminal"),
    terminal_state: z.enum([
      "completed",
      "failed",
      "cancelled",
      "deadline_exceeded",
      "blocked_on_human_input",
    ]),
  })
  .strict();

export const findingDeliveryLifecycleEventSchema = z.discriminatedUnion(
  "kind",
  [
    findingRegisteredEventSchema,
    semanticInputEventSchema,
    targetTerminalEventSchema,
  ],
);

const lifecycleLedgerBaseSchema = z
  .object({
    schema: z.literal(FINDING_DELIVERY_LIFECYCLE_SCHEMA),
    producer_revision: gitCommitSchema,
    run_id: runIDSchema,
    target: targetSchema,
    status: z.enum(["complete", "incomplete"]),
    incomplete_reason: z
      .enum([
        "terminal_unobserved",
        "ambiguous_transport_match",
        "producer_state_incomplete",
      ])
      .nullable(),
    events: z.array(findingDeliveryLifecycleEventSchema).max(65_536),
    finalized_at: utcTimestampSchema,
  })
  .strict();

export const findingDeliveryLifecycleSchema = lifecycleLedgerBaseSchema
  .superRefine((ledger, context) => {
    for (let index = 0; index < ledger.events.length; index += 1) {
      const event = ledger.events[index];
      if (event.seq !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["events", index, "seq"],
          message:
            "lifecycle sequence must be contiguous, unique, and start at 1",
        });
      }
      if (event.kind !== "target_terminal") {
        if (event.finding_id !== `h-runaway-${event.finding_sha256}`) {
          context.addIssue({
            code: "custom",
            path: ["events", index, "finding_id"],
            message: "finding_id must be h-runaway- followed by finding_sha256",
          });
        }
      }
    }

    const terminalIndexes = ledger.events.flatMap((event, index) =>
      event.kind === "target_terminal" ? [index] : []
    );
    if (terminalIndexes.length > 1) {
      context.addIssue({
        code: "custom",
        path: ["events"],
        message: "a lifecycle ledger may contain at most one terminal event",
      });
    }
    if (
      terminalIndexes.length === 1 &&
      terminalIndexes[0] !== ledger.events.length - 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["events", terminalIndexes[0]],
        message: "target_terminal must be the final lifecycle event",
      });
    }
    if (ledger.status === "complete") {
      if (ledger.incomplete_reason !== null || terminalIndexes.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message:
            "a complete ledger requires exactly one final terminal and no incomplete reason",
        });
      }
    } else if (ledger.incomplete_reason === null) {
      context.addIssue({
        code: "custom",
        path: ["incomplete_reason"],
        message: "an incomplete ledger requires an explicit reason",
      });
    }

    const registrations = new Map<
      string,
      { index: number; seq: number; registrationSha256: string }
    >();
    ledger.events.forEach((event, index) => {
      if (event.kind === "finding_registered") {
        if (registrations.has(event.finding_id)) {
          context.addIssue({
            code: "custom",
            path: ["events", index, "finding_id"],
            message: "a finding may be registered only once per target lifecycle",
          });
        } else {
          registrations.set(event.finding_id, {
            index,
            seq: event.seq,
            registrationSha256: event.registration_sha256,
          });
        }
      }
      if (event.kind === "semantic_input") {
        const registered = registrations.get(event.finding_id);
        if (
          registered === undefined ||
          registered.seq >= event.seq ||
          registered.registrationSha256 !== event.registration_sha256
        ) {
          context.addIssue({
            code: "custom",
            path: ["events", index],
            message: "semantic_input must match an earlier accepted registration",
          });
        }
      }
    });
  });

const deliveredReceiptSchema = z
  .object({
    schema: z.literal(FINDING_DELIVERY_RECEIPT_SCHEMA),
    producer_revision: gitCommitSchema,
    run_id: runIDSchema,
    ...findingIdentityShape,
    target: targetSchema,
    route: routeEvidenceSchema,
    registration_sha256: sha256Schema,
    lifecycle_ledger_sha256: sha256Schema,
    registered_seq: lifecycleSequenceSchema,
    outcome: z.literal("delivered"),
    delivery: z
      .object({
        semantic_input_seq: lifecycleSequenceSchema,
        turn_id: boundedIDSchema,
        transport_event_id: boundedIDSchema,
        input_packet_sha256: sha256Schema,
        surface: z.literal("provider_semantic_input"),
      })
      .strict(),
    terminal_seq: lifecycleSequenceSchema,
    reason: z.null(),
    emitted_at: utcTimestampSchema,
  })
  .strict();

const notDeliveredReceiptSchema = z
  .object({
    schema: z.literal(FINDING_DELIVERY_RECEIPT_SCHEMA),
    producer_revision: gitCommitSchema,
    run_id: runIDSchema,
    ...findingIdentityShape,
    target: targetSchema,
    route: routeEvidenceSchema,
    registration_sha256: sha256Schema,
    lifecycle_ledger_sha256: sha256Schema,
    registered_seq: lifecycleSequenceSchema,
    outcome: z.literal("not_delivered"),
    delivery: z.null(),
    terminal_seq: lifecycleSequenceSchema,
    reason: z.enum([
      "no_semantic_input_before_terminal",
      "no_coordination_channel",
    ]),
    emitted_at: utcTimestampSchema,
  })
  .strict();

const unknownReceiptSchema = z
  .object({
    schema: z.literal(FINDING_DELIVERY_RECEIPT_SCHEMA),
    producer_revision: gitCommitSchema,
    run_id: runIDSchema,
    ...findingIdentityShape,
    target: targetSchema,
    route: routeEvidenceSchema,
    registration_sha256: sha256Schema,
    lifecycle_ledger_sha256: sha256Schema,
    registered_seq: lifecycleSequenceSchema,
    outcome: z.literal("unknown"),
    delivery: z.null(),
    terminal_seq: lifecycleSequenceSchema.nullable(),
    reason: z.enum([
      "terminal_unobserved",
      "ambiguous_transport_match",
      "producer_state_incomplete",
    ]),
    emitted_at: utcTimestampSchema,
  })
  .strict();

export const findingDeliveryReceiptSchema = z
  .discriminatedUnion("outcome", [
    deliveredReceiptSchema,
    notDeliveredReceiptSchema,
    unknownReceiptSchema,
  ])
  .superRefine((receipt, context) => {
    addFindingIdentityIssue(receipt, context);
    if (receipt.outcome === "delivered") {
      if (
        receipt.route.transport_event_id === null ||
        receipt.route.transport_event_id !==
          receipt.delivery.transport_event_id
      ) {
        context.addIssue({
          code: "custom",
          path: ["route", "transport_event_id"],
          message: "delivered receipt route event must match delivery evidence",
        });
      }
      if (
        !(
          receipt.registered_seq < receipt.delivery.semantic_input_seq &&
          receipt.delivery.semantic_input_seq < receipt.terminal_seq
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["delivery", "semantic_input_seq"],
          message: "delivered ordering must be registered < semantic input < terminal",
        });
      }
    } else if (receipt.outcome === "not_delivered") {
      if (receipt.registered_seq >= receipt.terminal_seq) {
        context.addIssue({
          code: "custom",
          path: ["terminal_seq"],
          message: "not_delivered ordering must be registered < terminal",
        });
      }
      if (
        receipt.reason === "no_coordination_channel" &&
        (receipt.route.channel !== "bare_no_coordination" ||
          receipt.route.transport_event_id !== null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "no_coordination_channel is valid only for a bare route without an event",
        });
      }
    } else if (receipt.terminal_seq !== null && receipt.registered_seq >= receipt.terminal_seq) {
      context.addIssue({
        code: "custom",
        path: ["terminal_seq"],
        message: "an observed terminal must follow registration",
      });
    }
  });

const artifactReferenceSchema = z
  .object({
    path: relativeArtifactPathSchema,
    sha256: sha256Schema,
  })
  .strict();

const findingArtifactReferenceSchema = artifactReferenceSchema.extend({
  finding_id: findingIDSchema,
  lane_id: runIDSchema,
});

const lifecycleArtifactReferenceSchema = artifactReferenceSchema.extend({
  lane_id: runIDSchema,
});

export const findingDeliveryCastBindingSchema = z
  .object({
    schema: z.literal(FINDING_DELIVERY_CAST_BINDING_SCHEMA),
    producer_revision: gitCommitSchema,
    run_id: runIDSchema,
    manifest_sha256: sha256Schema,
    preregistration_sha256: sha256Schema,
    contract: z
      .object({
        registration_schema: z.literal(FINDING_DELIVERY_REGISTRATION_SCHEMA),
        receipt_schema: z.literal(FINDING_DELIVERY_RECEIPT_SCHEMA),
        lifecycle_schema: z.literal(FINDING_DELIVERY_LIFECYCLE_SCHEMA),
      })
      .strict(),
    route: routePinSchema,
    registrations: z.array(findingArtifactReferenceSchema).max(65_536),
    receipts: z.array(findingArtifactReferenceSchema).max(65_536),
    lifecycles: z.array(lifecycleArtifactReferenceSchema).max(16),
  })
  .strict()
  .superRefine((binding, context) => {
    const seenPaths = new Set<string>();
    const checkPaths = (
      values: ReadonlyArray<{ path: string }>,
      collection: "registrations" | "receipts" | "lifecycles",
    ): void => {
      values.forEach((value, index) => {
        if (seenPaths.has(value.path)) {
          context.addIssue({
            code: "custom",
            path: [collection, index, "path"],
            message:
              "artifact paths must be globally unique in the cast binding",
          });
        }
        seenPaths.add(value.path);
      });
    };
    checkPaths(binding.registrations, "registrations");
    checkPaths(binding.receipts, "receipts");
    checkPaths(binding.lifecycles, "lifecycles");

    const keys = (
      values: ReadonlyArray<{ finding_id: string; lane_id: string }>,
      collection: "registrations" | "receipts",
    ): Set<string> => {
      const result = new Set<string>();
      values.forEach((value, index) => {
        const key = `${value.finding_id}\0${value.lane_id}`;
        if (result.has(key)) {
          context.addIssue({
            code: "custom",
            path: [collection, index],
            message: "finding artifacts must be unique by finding and target lane",
          });
        }
        result.add(key);
      });
      return result;
    };
    const registrationKeys = keys(binding.registrations, "registrations");
    const receiptKeys = keys(binding.receipts, "receipts");
    if (
      registrationKeys.size !== receiptKeys.size ||
      [...registrationKeys].some((key) => !receiptKeys.has(key))
    ) {
      context.addIssue({
        code: "custom",
        path: ["receipts"],
        message: "cast binding must pair every accepted registration with exactly one receipt",
      });
    }

    const lifecycleLanes = new Set<string>();
    binding.lifecycles.forEach((lifecycle, index) => {
      if (lifecycleLanes.has(lifecycle.lane_id)) {
        context.addIssue({
          code: "custom",
          path: ["lifecycles", index, "lane_id"],
          message: "cast binding may contain only one lifecycle ledger per lane",
        });
      }
      lifecycleLanes.add(lifecycle.lane_id);
    });
    for (const registration of binding.registrations) {
      if (!lifecycleLanes.has(registration.lane_id)) {
        context.addIssue({
          code: "custom",
          path: ["lifecycles"],
          message: "every registered target lane requires a bound lifecycle ledger",
        });
      }
    }
  });

export type FindingDeliveryRegistration = z.infer<
  typeof findingDeliveryRegistrationSchema
>;
export type FindingDeliveryLifecycle = z.infer<
  typeof findingDeliveryLifecycleSchema
>;
export type FindingDeliveryReceipt = z.infer<
  typeof findingDeliveryReceiptSchema
>;
export type FindingDeliveryCastBinding = z.infer<
  typeof findingDeliveryCastBindingSchema
>;

export function parseFindingDeliveryRegistration(
  input: unknown,
): FindingDeliveryRegistration {
  return findingDeliveryRegistrationSchema.parse(input);
}

export function parseFindingDeliveryLifecycle(
  input: unknown,
): FindingDeliveryLifecycle {
  return findingDeliveryLifecycleSchema.parse(input);
}

export function parseFindingDeliveryReceipt(
  input: unknown,
): FindingDeliveryReceipt {
  return findingDeliveryReceiptSchema.parse(input);
}

export function parseFindingDeliveryCastBinding(
  input: unknown,
): FindingDeliveryCastBinding {
  return findingDeliveryCastBindingSchema.parse(input);
}

export function findingDeliveryArtifactSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function coalesceFindingDeliveryReceipts(
  values: ReadonlyArray<string | Buffer>,
): FindingDeliveryReceipt[] {
  const receipts: FindingDeliveryReceipt[] = [];
  const bytesByIdentity = new Map<string, Buffer>();
  const identityByDedupKey = new Map<string, string>();
  const identityByTransportEvent = new Map<string, string>();
  for (const value of values) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    const receipt = parseFindingDeliveryReceipt(
      parseArtifactJSON(bytes, "finding receipt"),
    );
    const identity =
      `${receipt.run_id}\0${receipt.finding_id}\0${receipt.target.lane_id}`;
    const existingBytes = bytesByIdentity.get(identity);
    if (existingBytes !== undefined) {
      if (!existingBytes.equals(bytes)) {
        throw new Error("conflicting finding receipts share one logical identity");
      }
      continue;
    }
    const dedupIdentity = identityByDedupKey.get(receipt.route.dedup_key);
    if (dedupIdentity !== undefined && dedupIdentity !== identity) {
      throw new Error("finding receipt dedup key was replayed across identities");
    }
    const transportEventID = receipt.route.transport_event_id;
    if (transportEventID !== null) {
      const eventIdentity = identityByTransportEvent.get(transportEventID);
      if (eventIdentity !== undefined && eventIdentity !== identity) {
        throw new Error(
          "finding receipt transport event was replayed across identities",
        );
      }
      identityByTransportEvent.set(transportEventID, identity);
    }
    bytesByIdentity.set(identity, bytes);
    identityByDedupKey.set(receipt.route.dedup_key, identity);
    receipts.push(receipt);
  }
  return receipts;
}

export interface FindingDeliveryExpectedRoute {
  runID: string;
  laneID: string;
  actorID: string;
  channel: z.infer<typeof findingDeliveryChannelSchema>;
  routeID: string;
}

function parseArtifactJSON(value: string | Buffer, label: string): unknown {
  try {
    return JSON.parse(value.toString());
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function validateFindingDeliveryEvidence(input: {
  registrationBytes: string | Buffer;
  lifecycleBytes: string | Buffer;
  receiptBytes: string | Buffer;
  expected: FindingDeliveryExpectedRoute;
}): {
  registration: FindingDeliveryRegistration;
  lifecycle: FindingDeliveryLifecycle;
  receipt: FindingDeliveryReceipt;
} {
  const registration = parseFindingDeliveryRegistration(
    parseArtifactJSON(input.registrationBytes, "finding registration"),
  );
  const lifecycle = parseFindingDeliveryLifecycle(
    parseArtifactJSON(input.lifecycleBytes, "finding lifecycle"),
  );
  const receipt = parseFindingDeliveryReceipt(
    parseArtifactJSON(input.receiptBytes, "finding receipt"),
  );
  const expectedTarget = {
    lane_id: input.expected.laneID,
    actor_id: input.expected.actorID,
  };
  const expectedRoute = {
    channel: input.expected.channel,
    route_id: input.expected.routeID,
  };
  if (
    registration.run_id !== input.expected.runID ||
    lifecycle.run_id !== input.expected.runID ||
    receipt.run_id !== input.expected.runID ||
    registration.target.lane_id !== expectedTarget.lane_id ||
    registration.target.actor_id !== expectedTarget.actor_id ||
    lifecycle.target.lane_id !== expectedTarget.lane_id ||
    lifecycle.target.actor_id !== expectedTarget.actor_id ||
    receipt.target.lane_id !== expectedTarget.lane_id ||
    receipt.target.actor_id !== expectedTarget.actor_id ||
    registration.route.channel !== expectedRoute.channel ||
    registration.route.route_id !== expectedRoute.route_id ||
    receipt.route.channel !== expectedRoute.channel ||
    receipt.route.route_id !== expectedRoute.route_id
  ) {
    throw new Error(
      "finding delivery evidence does not match the digest-pinned cast route",
    );
  }
  if (
    registration.finding_id !== receipt.finding_id ||
    registration.finding_sha256 !== receipt.finding_sha256
  ) {
    throw new Error("finding registration and receipt identity do not match");
  }
  const registrationSha256 = findingDeliveryArtifactSha256(
    input.registrationBytes,
  );
  const lifecycleSha256 = findingDeliveryArtifactSha256(
    input.lifecycleBytes,
  );
  if (
    receipt.registration_sha256 !== registrationSha256 ||
    receipt.lifecycle_ledger_sha256 !== lifecycleSha256
  ) {
    throw new Error("finding receipt artifact digest binding does not match");
  }
  if (receipt.producer_revision !== lifecycle.producer_revision) {
    throw new Error(
      "finding receipt and lifecycle producer revisions do not match",
    );
  }
  const registrationEvent = lifecycle.events.find(
    (event) => event.seq === receipt.registered_seq,
  );
  if (
    registrationEvent?.kind !== "finding_registered" ||
    registrationEvent.finding_id !== receipt.finding_id ||
    registrationEvent.finding_sha256 !== receipt.finding_sha256 ||
    registrationEvent.registration_sha256 !== registrationSha256
  ) {
    throw new Error(
      "receipt registered_seq does not bind the accepted registration",
    );
  }
  const terminalEvent = receipt.terminal_seq === null
    ? undefined
    : lifecycle.events.find((event) => event.seq === receipt.terminal_seq);
  if (
    receipt.terminal_seq !== null &&
    terminalEvent?.kind !== "target_terminal"
  ) {
    throw new Error(
      "receipt terminal_seq does not bind a target terminal event",
    );
  }

  if (receipt.outcome !== "unknown" && lifecycle.status !== "complete") {
    throw new Error("a conclusive receipt requires a complete lifecycle ledger");
  }
  if (receipt.outcome === "delivered") {
    const semanticInput = lifecycle.events.find(
      (event) => event.seq === receipt.delivery.semantic_input_seq,
    );
    if (
      semanticInput?.kind !== "semantic_input" ||
      semanticInput.finding_id !== receipt.finding_id ||
      semanticInput.finding_sha256 !== receipt.finding_sha256 ||
      semanticInput.registration_sha256 !== registrationSha256 ||
      semanticInput.turn_id !== receipt.delivery.turn_id ||
      semanticInput.transport_event_id !== receipt.delivery.transport_event_id ||
      semanticInput.input_packet_sha256 !== receipt.delivery.input_packet_sha256 ||
      semanticInput.surface !== receipt.delivery.surface
    ) {
      throw new Error(
        "delivered receipt does not bind matching semantic input evidence",
      );
    }
  } else if (receipt.outcome === "not_delivered") {
    const matchingSemanticInput = lifecycle.events.some(
      (event) =>
        event.kind === "semantic_input" &&
        event.finding_id === receipt.finding_id &&
        event.registration_sha256 === registrationSha256 &&
        event.seq > receipt.registered_seq &&
        event.seq < receipt.terminal_seq,
    );
    if (matchingSemanticInput) {
      throw new Error(
        "not_delivered receipt cannot coexist with matching semantic input evidence",
      );
    }
  }
  return { registration, lifecycle, receipt };
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

export function findingDeliveryRegistrationStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    findingDeliveryRegistrationSchema,
    FINDING_DELIVERY_REGISTRATION_JSON_SCHEMA_ID,
  );
}

export function findingDeliveryLifecycleStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    findingDeliveryLifecycleSchema,
    FINDING_DELIVERY_LIFECYCLE_JSON_SCHEMA_ID,
  );
}

export function findingDeliveryReceiptStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    findingDeliveryReceiptSchema,
    FINDING_DELIVERY_RECEIPT_JSON_SCHEMA_ID,
  );
}

export function findingDeliveryCastBindingStructuralJSONSchema(): Record<
  string,
  unknown
> {
  return structuralJSONSchema(
    findingDeliveryCastBindingSchema,
    FINDING_DELIVERY_CAST_BINDING_JSON_SCHEMA_ID,
  );
}
