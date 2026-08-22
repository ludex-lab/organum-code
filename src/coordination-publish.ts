import { createHash } from "node:crypto";

import type {
  AgoraPublishRequest,
  PublishReceipt,
  RelaySendRequest,
  SessionStatus,
} from "./organum-cli.js";
import type { SessionCoordinationState } from "./coordination-bootstrap.js";
import type { CellIdentity } from "./organum-identity.js";

export const PUBLICATION_PROTOCOL = 1;
export const PUBLICATION_MAX_BODY_BYTES = 64 * 1024;

export type PublicationPhase =
  | "clean"
  | "output_pending"
  | "reminded_once"
  | "publishing"
  | "published"
  | "publish_failed"
  | "ending"
  | "end_failed"
  | "shipped"
  | "nonconformant";

export type PublicationChannel = "agora" | "relay";

export interface PublicationClient {
  publishAgora(request: AgoraPublishRequest): Promise<PublishReceipt>;
  sendRelay(request: RelaySendRequest): Promise<PublishReceipt>;
  sessionStatus(
    identity: CellIdentity,
    signal?: AbortSignal,
  ): Promise<SessionStatus | null>;
  note(
    identity: CellIdentity,
    text: string,
    signal?: AbortSignal,
  ): Promise<void>;
  end(
    identity: CellIdentity,
    shippedFile: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface PublicationRequest {
  messageID: string;
  body: string;
  displayFrom?: string;
  topic?: string;
  thread?: string;
  replyTo?: string;
  escalate?: boolean;
  to?: string;
  handoff: boolean;
  signal?: AbortSignal;
}

export interface PublicationEvidence {
  protocol: number;
  phase: PublicationPhase;
  turn_id: string;
  channel: PublicationChannel;
  to: string | null;
  file: string;
  from_id: CellIdentity;
  idem_key: string;
  shipped: boolean;
}

export interface PublicationSnapshot {
  protocol: number;
  phase: PublicationPhase;
  turn_id: string | null;
  reminders: 0 | 1;
  receipt: {
    channel: PublicationChannel;
    to: string | null;
    file: string;
    from_id: CellIdentity;
    idem_key: string;
    topic: string | null;
    body_bytes: number;
    body_sha256: string;
  } | null;
  last_error: string | null;
  note_error: string | null;
  terminal_required: true;
}

export type IdlePublicationAction =
  | "ignored"
  | "reminded"
  | "nonconformant";

export class CoordinationPublishError extends Error {
  constructor(
    message: string,
    readonly kind: "conflict" | "contract" | "state",
  ) {
    super(message);
    this.name = "CoordinationPublishError";
  }
}

interface PublicationIntent {
  signature: string;
  turnID: string;
  channel: PublicationChannel;
  to: string | null;
  body: string;
  displayFrom?: string;
  topic?: string;
  thread?: string;
  replyTo?: string;
  escalate?: boolean;
}

interface RootPublicationEntry {
  identity: CellIdentity;
  phase: PublicationPhase;
  turnID: string | null;
  reminders: 0 | 1;
  intent: PublicationIntent | null;
  receipt: PublishReceipt | null;
  endAttempted: boolean;
  lastError: string | null;
  noteError: string | null;
  operation?: Promise<PublicationEvidence>;
  reminder?: Promise<IdlePublicationAction>;
}

function rootKey(directory: string, rootSessionID: string): string {
  return `${directory}\0${rootSessionID}`;
}

function sessionKey(directory: string, sessionID: string): string {
  return `${directory}\0${sessionID}`;
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "unknown publication error";
  const redacted = raw
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  return Array.from(redacted).slice(0, 256).join("");
}

function boundedValue(
  value: string | undefined,
  field: string,
  maxBytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new CoordinationPublishError(
      `${field} must be at most ${maxBytes} UTF-8 bytes without NUL`,
      "contract",
    );
  }
  return value;
}

function publicationIntent(
  entry: RootPublicationEntry,
  request: PublicationRequest,
): PublicationIntent {
  const body = boundedValue(
    request.body,
    "Publication body",
    PUBLICATION_MAX_BODY_BYTES,
  )!;
  if (body.trim().length === 0) {
    throw new CoordinationPublishError(
      "Publication body must not be empty",
      "contract",
    );
  }
  const messageID = boundedValue(request.messageID, "Backend turn ID", 256)!;
  if (messageID.trim().length === 0) {
    throw new CoordinationPublishError(
      "Backend turn ID must not be empty",
      "contract",
    );
  }
  const turnID = entry.turnID ?? messageID;
  const to = boundedValue(request.to, "Relay recipient", 128);
  if (to !== undefined && to.trim().length === 0) {
    throw new CoordinationPublishError(
      "Relay recipient must not be empty",
      "contract",
    );
  }
  const intent = {
    turnID,
    channel: to === undefined ? ("agora" as const) : ("relay" as const),
    to: to ?? null,
    body,
    displayFrom: boundedValue(request.displayFrom, "Display label", 256),
    topic: boundedValue(request.topic, "Topic", 128),
    thread: boundedValue(request.thread, "Thread", 256),
    replyTo: boundedValue(request.replyTo, "Reply target", 256),
    escalate: request.escalate,
  };
  return {
    ...intent,
    signature: JSON.stringify(intent),
  };
}

function evidence(entry: RootPublicationEntry): PublicationEvidence {
  if (entry.intent === null || entry.receipt === null) {
    throw new CoordinationPublishError(
      "Publication evidence is unavailable",
      "state",
    );
  }
  return {
    protocol: PUBLICATION_PROTOCOL,
    phase: entry.phase,
    turn_id: entry.intent.turnID,
    channel: entry.intent.channel,
    to: entry.intent.to,
    file: entry.receipt.file,
    from_id: entry.receipt.fromID,
    idem_key: entry.receipt.idempotencyKey,
    shipped: entry.phase === "shipped",
  };
}

export class SessionPublicationStateMachine {
  private readonly roots = new Map<string, RootPublicationEntry>();
  private readonly sessions = new Map<string, string>();

  constructor(private readonly organum: PublicationClient) {}

  private bind(
    state: SessionCoordinationState,
    directory: string,
  ): RootPublicationEntry {
    const key = rootKey(directory, state.rootSessionID);
    let entry = this.roots.get(key);
    if (entry === undefined) {
      entry = {
        identity: state.identity,
        phase: "clean",
        turnID: null,
        reminders: 0,
        intent: null,
        receipt: null,
        endAttempted: false,
        lastError: null,
        noteError: null,
      };
      this.roots.set(key, entry);
    } else if (entry.identity !== state.identity) {
      throw new CoordinationPublishError(
        "Publication root identity changed unexpectedly",
        "state",
      );
    }
    for (const sessionID of state.lineage) {
      this.sessions.set(sessionKey(directory, sessionID), key);
    }
    this.sessions.set(sessionKey(directory, state.rootSessionID), key);
    return entry;
  }

  snapshot(
    state: SessionCoordinationState,
    directory: string,
  ): PublicationSnapshot {
    return this.snapshotEntry(this.bind(state, directory));
  }

  async observeOutput(
    state: SessionCoordinationState,
    directory: string,
    messageID: string,
    text: string,
  ): Promise<PublicationSnapshot> {
    if (text.trim().length === 0) {
      return this.snapshot(state, directory);
    }
    return await this.beginTurn(state, directory, messageID);
  }

  async beginTurn(
    state: SessionCoordinationState,
    directory: string,
    messageID: string,
  ): Promise<PublicationSnapshot> {
    const entry = this.bind(state, directory);
    boundedValue(messageID, "Backend turn ID", 256);

    if (["shipped", "nonconformant"].includes(entry.phase)) {
      return this.snapshotEntry(entry);
    }

    if (
      entry.intent?.turnID === messageID &&
      ["publishing", "published", "ending", "end_failed"].includes(
        entry.phase,
      )
    ) {
      return this.snapshotEntry(entry);
    }
    if (entry.phase === "clean") {
      entry.turnID = messageID;
      entry.phase = "output_pending";
    } else if (
      ["published", "shipped"].includes(entry.phase) &&
      entry.intent?.turnID !== messageID
    ) {
      entry.phase = "output_pending";
      entry.turnID = messageID;
      entry.reminders = 0;
      entry.intent = null;
      entry.receipt = null;
      entry.endAttempted = false;
      entry.lastError = null;
      entry.noteError = null;
    }
    return this.snapshotEntry(entry);
  }

  discardUnadmittedTurn(
    state: SessionCoordinationState,
    directory: string,
    messageID: string,
  ): PublicationSnapshot {
    const entry = this.bind(state, directory);
    if (
      entry.turnID === messageID &&
      entry.receipt === null &&
      entry.intent === null &&
      entry.operation === undefined &&
      (entry.phase === "output_pending" || entry.phase === "reminded_once")
    ) {
      entry.phase = "clean";
      entry.turnID = null;
      entry.reminders = 0;
      entry.lastError = null;
      entry.noteError = null;
    }
    return this.snapshotEntry(entry);
  }

  async publish(
    state: SessionCoordinationState,
    directory: string,
    request: PublicationRequest,
  ): Promise<PublicationEvidence> {
    const entry = this.bind(state, directory);
    const intent = publicationIntent(entry, request);
    if (entry.intent !== null && entry.intent.signature !== intent.signature) {
      throw new CoordinationPublishError(
        "This output obligation already has a different publication intent; retry the exact same content and routing fields",
        "conflict",
      );
    }
    if (entry.operation !== undefined) {
      return await entry.operation;
    }
    if (entry.receipt !== null) {
      if (!request.handoff) return evidence(entry);
      entry.operation = this.finishHandoff(entry, request.signal).finally(() => {
        entry.operation = undefined;
      });
      return await entry.operation;
    }

    entry.intent = intent;
    entry.turnID = intent.turnID;
    entry.operation = this.perform(entry, request).finally(() => {
      entry.operation = undefined;
    });
    return await entry.operation;
  }

  async handleIdle(
    sessionID: string,
    directory: string,
    remind: () => Promise<void>,
  ): Promise<IdlePublicationAction> {
    const key = this.sessions.get(sessionKey(directory, sessionID));
    if (key === undefined) return "ignored";
    const entry = this.roots.get(key);
    if (entry === undefined) return "ignored";
    if (entry.operation !== undefined) return "ignored";
    if (["clean", "shipped", "nonconformant"].includes(entry.phase)) {
      return "ignored";
    }
    if (entry.reminder !== undefined) return await entry.reminder;

    entry.reminder = this.remindOrFail(entry, remind).finally(() => {
      entry.reminder = undefined;
    });
    return await entry.reminder;
  }

  private async perform(
    entry: RootPublicationEntry,
    request: PublicationRequest,
  ): Promise<PublicationEvidence> {
    const intent = entry.intent!;
    entry.phase = "publishing";
    entry.lastError = null;
    try {
      entry.receipt =
        intent.channel === "agora"
          ? await this.organum.publishAgora({
              identity: entry.identity,
              turnID: intent.turnID,
              body: intent.body,
              displayFrom: intent.displayFrom,
              topic: intent.topic,
              thread: intent.thread,
              replyTo: intent.replyTo,
              escalate: intent.escalate,
              signal: request.signal,
            })
          : await this.organum.sendRelay({
              identity: entry.identity,
              turnID: intent.turnID,
              body: intent.body,
              to: intent.to!,
              displayFrom: intent.displayFrom,
              topic: intent.topic,
              thread: intent.thread,
              replyTo: intent.replyTo,
              escalate: intent.escalate,
              signal: request.signal,
            });
    } catch (error) {
      entry.lastError = safeError(error);
      entry.phase = "publish_failed";
      await this.safeNote(entry, `${entry.phase}: ${entry.lastError}`, request.signal);
      throw error;
    }
    entry.phase = "published";
    if (request.handoff) return await this.finishHandoff(entry, request.signal);
    return evidence(entry);
  }

  private async finishHandoff(
    entry: RootPublicationEntry,
    signal?: AbortSignal,
  ): Promise<PublicationEvidence> {
    if (entry.receipt === null) {
      throw new CoordinationPublishError(
        "Cannot end a session before durable publication evidence exists",
        "state",
      );
    }
    entry.phase = "ending";
    try {
      const status = await this.organum.sessionStatus(entry.identity, signal);
      if (status === null) {
        if (entry.endAttempted) {
          entry.phase = "shipped";
          entry.lastError = null;
          return evidence(entry);
        }
        throw new CoordinationPublishError(
          "No open Organum session exists for the publication handoff",
          "state",
        );
      }
      entry.endAttempted = true;
      await this.organum.end(entry.identity, entry.receipt.file, signal);
      entry.phase = "shipped";
      entry.lastError = null;
      return evidence(entry);
    } catch (error) {
      entry.phase = "end_failed";
      entry.lastError = safeError(error);
      await this.safeNote(entry, `end_failed: ${entry.lastError}`, signal);
      throw error;
    }
  }

  private async remindOrFail(
    entry: RootPublicationEntry,
    remind: () => Promise<void>,
  ): Promise<IdlePublicationAction> {
    if (entry.reminders === 0) {
      const previous = entry.phase;
      entry.reminders = 1;
      entry.phase = "reminded_once";
      try {
        await remind();
        return "reminded";
      } catch (error) {
        entry.reminders = 0;
        entry.phase = previous;
        entry.lastError = safeError(error);
        return "ignored";
      }
    }
    entry.phase = "nonconformant";
    entry.lastError =
      "Durable publication and ship evidence remained missing after one close-out reminder";
    await this.safeNote(entry, `nonconformant: ${entry.lastError}`);
    return "nonconformant";
  }

  private async safeNote(
    entry: RootPublicationEntry,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.organum.note(entry.identity, text, signal);
      entry.noteError = null;
    } catch (error) {
      entry.noteError = safeError(error);
    }
  }

  private snapshotEntry(entry: RootPublicationEntry): PublicationSnapshot {
    return {
      protocol: PUBLICATION_PROTOCOL,
      phase: entry.phase,
      turn_id: entry.turnID,
      reminders: entry.reminders,
      receipt:
        entry.intent === null || entry.receipt === null
          ? null
          : {
              channel: entry.intent.channel,
              to: entry.intent.to,
              file: entry.receipt.file,
              from_id: entry.receipt.fromID,
              idem_key: entry.receipt.idempotencyKey,
              topic: entry.intent.topic ?? null,
              body_bytes: Buffer.byteLength(entry.intent.body, "utf8"),
              body_sha256: createHash("sha256")
                .update(entry.intent.body)
                .digest("hex"),
            },
      last_error: entry.lastError,
      note_error: entry.noteError,
      terminal_required: true,
    };
  }

  clear(): void {
    this.roots.clear();
    this.sessions.clear();
  }
}
