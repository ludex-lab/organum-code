import {
  InferenceBrokerError,
  type InferenceBrokerRequestLifecycle,
  type JsonObject,
} from "./inference-broker.js";
import type {
  NativeCoordinationTurn,
  NativeProductLifecycle,
} from "./native-product-lifecycle.js";

type CastCoordinationLifecycle = Pick<
  NativeProductLifecycle,
  | "prepareCoordinationTurn"
  | "admitCoordinationTurn"
  | "discardCoordinationTurn"
>;

interface RequestSlotWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal | undefined;
  abort: (() => void) | undefined;
  cancelled: boolean;
}

function injectPacket(
  body: Readonly<JsonObject>,
  turn: NativeCoordinationTurn,
): JsonObject {
  if (Array.isArray(body.messages)) {
    return {
      ...body,
      messages: [
        { role: "system", content: turn.packet.text },
        ...body.messages,
      ],
    };
  }
  const packet = {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text: turn.packet.text }],
  };
  if (Array.isArray(body.input)) {
    return { ...body, input: [packet, ...body.input] };
  }
  if (typeof body.input === "string") {
    return {
      ...body,
      input: [
        packet,
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: body.input }],
        },
      ],
    };
  }
  throw new InferenceBrokerError(
    "Organism cast coordination requires a Messages or Responses request body",
    500,
    "cast_coordination_request_shape_unsupported",
  );
}

export class OrganismCastBrokerCoordination
  implements InferenceBrokerRequestLifecycle {
  readonly #lifecycle: CastCoordinationLifecycle;
  readonly #turnPrefix: string;
  #sequence = 1;
  #turnID: string | null;
  #requestID: string | null = null;
  #completed = false;
  #slotHeld = false;
  readonly #slotWaiters: RequestSlotWaiter[] = [];

  constructor(
    lifecycle: CastCoordinationLifecycle,
    initialTurnID: string,
  ) {
    this.#lifecycle = lifecycle;
    this.#turnPrefix = initialTurnID;
    this.#turnID = initialTurnID;
  }

  async prepare(input: {
    requestID: string;
    body: Readonly<JsonObject>;
    signal?: AbortSignal;
  }): Promise<JsonObject> {
    await this.#acquireSlot(input.signal);
    try {
      if (this.#turnID !== null && this.#requestID === null) {
        this.#requestID = input.requestID;
        return { ...input.body };
      }
      if (this.#turnID !== null) {
        if (!this.#completed) {
          throw new InferenceBrokerError(
            "Organism cast provider request slot was released before completion",
            500,
            "cast_coordination_incomplete_slot",
          );
        }
        await this.#lifecycle.admitCoordinationTurn(this.#turnID);
        this.#clear();
      }

      const turnID = `${this.#turnPrefix}:provider-${++this.#sequence}`;
      const turn = await this.#lifecycle.prepareCoordinationTurn(turnID);
      try {
        const body = injectPacket(input.body, turn);
        this.#turnID = turnID;
        this.#requestID = input.requestID;
        return body;
      } catch (error) {
        this.#lifecycle.discardCoordinationTurn(turnID);
        throw error;
      }
    } catch (error) {
      this.#releaseRequestSlot();
      throw error;
    }
  }

  complete(input: {
    requestID: string;
    successful: boolean;
  }): void {
    if (
      this.#turnID === null ||
      this.#requestID === null ||
      this.#requestID !== input.requestID
    ) {
      throw new InferenceBrokerError(
        "Organism cast provider completion does not match its coordination turn",
        500,
        "cast_coordination_completion_mismatch",
      );
    }
    try {
      if (input.successful) {
        this.#completed = true;
        return;
      }
      this.#lifecycle.discardCoordinationTurn(this.#turnID);
      this.#clear();
    } finally {
      this.#releaseRequestSlot();
    }
  }

  async finish(cleanExit: boolean): Promise<void> {
    if (this.#turnID === null) return;
    if (cleanExit && this.#completed) {
      await this.#lifecycle.admitCoordinationTurn(this.#turnID);
    } else {
      this.#lifecycle.discardCoordinationTurn(this.#turnID);
    }
    this.#clear();
  }

  #clear(): void {
    this.#turnID = null;
    this.#requestID = null;
    this.#completed = false;
  }

  async #acquireSlot(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new InferenceBrokerError(
        "Organism cast provider request was cancelled while awaiting coordination",
        499,
        "request_cancelled",
      );
    }
    if (!this.#slotHeld) {
      this.#slotHeld = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: RequestSlotWaiter = {
        resolve,
        reject,
        signal,
        abort: undefined,
        cancelled: false,
      };
      if (signal !== undefined) {
        waiter.abort = () => {
          waiter.cancelled = true;
          reject(new InferenceBrokerError(
            "Organism cast provider request was cancelled while awaiting coordination",
            499,
            "request_cancelled",
          ));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#slotWaiters.push(waiter);
    });
  }

  #releaseRequestSlot(): void {
    while (this.#slotWaiters.length > 0) {
      const waiter = this.#slotWaiters.shift()!;
      if (waiter.abort !== undefined) {
        waiter.signal?.removeEventListener("abort", waiter.abort);
      }
      if (waiter.cancelled) continue;
      waiter.resolve();
      return;
    }
    this.#slotHeld = false;
  }
}
