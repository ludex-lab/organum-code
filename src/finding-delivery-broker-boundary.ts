import {
  InferenceBrokerError,
  type InferenceBrokerRequestLifecycle,
  type JsonObject,
} from "./inference-broker.js";
import {
  findingDeliveryArtifactSha256,
  FINDING_DELIVERY_SEMANTIC_INPUT_SURFACE,
  prepareFindingDeliverySemanticInputPacket,
  type PreparedFindingDeliverySemanticInputPacket,
} from "./finding-delivery.js";

interface FindingDeliveryBoundaryDelegate
  extends InferenceBrokerRequestLifecycle {
  finish?(cleanExit: boolean): void | Promise<void>;
}

interface PacketEntry {
  prepared: PreparedFindingDeliverySemanticInputPacket;
  targetLaneID: string;
  state: "pending" | "active" | "delivered";
}

interface ActivePacket {
  entry: PacketEntry;
  accepted: boolean;
}

function copyPrepared(
  prepared: PreparedFindingDeliverySemanticInputPacket,
): PreparedFindingDeliverySemanticInputPacket {
  return {
    packet: prepared.packet,
    bytes: Buffer.from(prepared.bytes),
    text: prepared.text,
    sha256: prepared.sha256,
  };
}

export interface FindingDeliveryProviderSemanticInputEvidence {
  run_id: string;
  finding_id: string;
  turn_id: string;
  transport_event_id: string;
  input_packet_sha256: string;
  surface: typeof FINDING_DELIVERY_SEMANTIC_INPUT_SURFACE;
}

export interface FindingDeliveryBrokerBoundarySnapshot {
  pending: number;
  active: number;
  delivered: number;
}

const TARGET_LANE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function injectPacket(
  body: Readonly<JsonObject>,
  prepared: PreparedFindingDeliverySemanticInputPacket,
): JsonObject {
  if (!Array.isArray(body.messages)) {
    throw new InferenceBrokerError(
      "Finding delivery requires a messages request body",
      500,
      "finding_delivery_request_shape_unsupported",
    );
  }
  if (body.messages.some((message) => record(message)?.content === prepared.text)) {
    throw new InferenceBrokerError(
      "Finding semantic-input packet is already present in the request",
      500,
      "finding_delivery_packet_duplicate",
    );
  }
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "user", content: prepared.text },
    ],
  };
}

function assertPacketAtFinalProviderBoundary(
  body: Readonly<JsonObject>,
  prepared: PreparedFindingDeliverySemanticInputPacket,
): void {
  const matches = Array.isArray(body.messages)
    ? body.messages.filter((message) => {
        const value = record(message);
        return value?.role === "user" &&
          typeof value.content === "string" &&
          Buffer.from(value.content, "utf8").equals(prepared.bytes);
      })
    : [];
  if (matches.length !== 1) {
    throw new InferenceBrokerError(
      "Finding semantic-input packet changed before provider dispatch",
      500,
      "finding_delivery_packet_boundary_mismatch",
    );
  }
}

/**
 * A provider-request lifecycle decorator that injects at most one pending
 * finding packet per request and proves its exact message-content bytes after
 * the broker's final request transform. A delivery becomes evidence only once
 * upstream has returned a successful response.
 */
export class FindingDeliveryBrokerBoundary
  implements InferenceBrokerRequestLifecycle {
  readonly #delegate: FindingDeliveryBoundaryDelegate | undefined;
  readonly #entries = new Map<string, PacketEntry>();
  readonly #pending: PacketEntry[] = [];
  readonly #active = new Map<string, ActivePacket>();
  readonly #delivered: FindingDeliveryProviderSemanticInputEvidence[] = [];

  constructor(delegate?: FindingDeliveryBoundaryDelegate) {
    this.#delegate = delegate;
  }

  enqueue(input: {
    run_id: string;
    finding_id: string;
    action_token: string;
    target_lane_id: string;
  }): PreparedFindingDeliverySemanticInputPacket {
    if (!TARGET_LANE_ID_PATTERN.test(input.target_lane_id)) {
      throw new TypeError("Finding delivery target lane ID is invalid");
    }
    const prepared = prepareFindingDeliverySemanticInputPacket({
      run_id: input.run_id,
      finding_id: input.finding_id,
      action_token: input.action_token,
    });
    const identity =
      `${prepared.packet.run_id}\0${input.target_lane_id}\0${prepared.packet.finding_id}`;
    const existing = this.#entries.get(identity);
    if (existing !== undefined) {
      if (existing.prepared.sha256 !== prepared.sha256) {
        throw new InferenceBrokerError(
          "Conflicting finding semantic-input packets share one identity",
          409,
          "finding_delivery_packet_conflict",
        );
      }
      return copyPrepared(existing.prepared);
    }
    const entry: PacketEntry = {
      prepared,
      targetLaneID: input.target_lane_id,
      state: "pending",
    };
    this.#entries.set(identity, entry);
    this.#pending.push(entry);
    return copyPrepared(prepared);
  }

  async prepare(input: {
    requestID: string;
    body: Readonly<JsonObject>;
    signal?: AbortSignal;
  }): Promise<JsonObject> {
    const body = this.#delegate === undefined
      ? { ...input.body }
      : await this.#delegate.prepare(input);
    const entry = this.#pending.shift();
    if (entry === undefined) return body;
    try {
      const injected = injectPacket(body, entry.prepared);
      entry.state = "active";
      this.#active.set(input.requestID, { entry, accepted: false });
      return injected;
    } catch (error) {
      this.#pending.unshift(entry);
      try {
        await this.#delegate?.complete({
          requestID: input.requestID,
          successful: false,
        });
      } catch {
        // Preserve the exact injection failure as the authoritative cause.
      }
      throw error;
    }
  }

  async verify(input: {
    requestID: string;
    body: Readonly<JsonObject>;
  }): Promise<void> {
    await this.#delegate?.verify?.(input);
    const active = this.#active.get(input.requestID);
    if (active !== undefined) {
      assertPacketAtFinalProviderBoundary(input.body, active.entry.prepared);
    }
  }

  async accepted(input: { requestID: string }): Promise<void> {
    const active = this.#active.get(input.requestID);
    if (active !== undefined) {
      if (active.accepted) {
        throw new InferenceBrokerError(
          "Finding provider request was accepted more than once",
          500,
          "finding_delivery_acceptance_duplicate",
        );
      }
      active.accepted = true;
      active.entry.state = "delivered";
      const transportEventID = `provider-semantic-input:${findingDeliveryArtifactSha256(
        `${active.entry.prepared.packet.run_id}\0${active.entry.targetLaneID}\0${active.entry.prepared.packet.finding_id}\0${input.requestID}`,
      )}`;
      this.#delivered.push(Object.freeze({
        run_id: active.entry.prepared.packet.run_id,
        finding_id: active.entry.prepared.packet.finding_id,
        turn_id: transportEventID,
        transport_event_id: transportEventID,
        input_packet_sha256: active.entry.prepared.sha256,
        surface: FINDING_DELIVERY_SEMANTIC_INPUT_SURFACE,
      }));
    }
    await this.#delegate?.accepted?.(input);
  }

  async complete(input: {
    requestID: string;
    successful: boolean;
  }): Promise<void> {
    const active = this.#active.get(input.requestID);
    if (active !== undefined) {
      this.#active.delete(input.requestID);
      if (!active.accepted) {
        active.entry.state = "pending";
        this.#pending.unshift(active.entry);
      }
    }
    await this.#delegate?.complete(input);
  }

  async finish(cleanExit: boolean): Promise<void> {
    await this.#delegate?.finish?.(cleanExit);
  }

  deliveryEvidence(): readonly FindingDeliveryProviderSemanticInputEvidence[] {
    return this.#delivered.map((evidence) => ({ ...evidence }));
  }

  snapshot(): FindingDeliveryBrokerBoundarySnapshot {
    return {
      pending: this.#pending.length,
      active: this.#active.size,
      delivered: this.#delivered.length,
    };
  }
}
