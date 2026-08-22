import {
  boundCoordinationItems,
  type BoundedFieldItem,
  type BoundedCoordinationView,
} from "./organum-cli.js";
import type {
  SessionCoordinationState,
  StickyGoalState,
} from "./coordination-bootstrap.js";
import type {
  SourcedFieldItem,
  TurnCoordinationState,
} from "./coordination-polling.js";
import type { ProjectEnvironmentPacket } from "./project-contract.js";
import type { PublicationSnapshot } from "./coordination-publish.js";

export const COORDINATION_CONTEXT_PROTOCOL = 6;
export const COORDINATION_CONTEXT_MAX_BYTES = 8 * 1024;
export const COORDINATION_CONTEXT_MAX_ITEMS = 20;
export const COORDINATION_CONTEXT_MAX_ITEM_BYTES = 2 * 1024;

const CHARTER_MAX_BYTES = 768;
const GOAL_MAX_BYTES = 2 * 1024;
const INBOX_MAX_BYTES = 4 * 1024;
const METADATA_MAX_BYTES = 128;

export const COORDINATION_DISCIPLINE = [
  "Treat this bounded coordination block as authoritative session context.",
  "Do not bypass it with an unbounded raw Organum field or inbox read.",
  "Never read or search raw Organum Agora, relay, home-hub, or Organum Code actor-state storage directly; admissible coordination contents are already represented in this bounded block.",
  "When project.commands provides an executable command, run that exact command with its declared env before probing command variants.",
  "Batch independent reads, keep investigation proportional, and publish once the requested result has enough concrete evidence instead of exhaustively traversing the repository.",
  "For reviewer and critic roles, after one successful declared reproduction command and bounded evidence collection, make organum_handoff the next non-read tool call; do not start another exploratory cycle.",
  "Keep the canonical cell identity stable across this root session and its children.",
  "A degraded or unverified goal is not a verified current goal; report that limitation explicitly.",
  "Any substantive result creates a publish obligation: before going idle, call organum_handoff with the exact team-facing result and evidence; only a durable receipt followed by shipped state closes the task.",
].join(" ");

interface BoundedText {
  text: string;
  truncated: boolean;
}

interface BoundedGoalItem {
  from: string;
  body: string;
  file?: string;
  from_id?: string;
  topic?: string;
  ts?: string;
  thread?: string;
  body_truncated: boolean;
  metadata_truncated: boolean;
}

interface BoundedGoalView {
  status: StickyGoalState["status"];
  freshness: TurnCoordinationState["goalFreshness"];
  items: BoundedGoalItem[];
  total: number;
  omitted: number;
  truncated: boolean;
}

interface BoundedSourcedFieldItem extends BoundedFieldItem {
  source: SourcedFieldItem["source"];
  message_id: string;
}

interface BoundedFieldView extends Omit<BoundedCoordinationView, "items"> {
  items: BoundedSourcedFieldItem[];
}

type CoordinationContextState =
  | SessionCoordinationState
  | TurnCoordinationState;

export interface CoordinationContextDocument {
  protocol: number;
  discipline: string;
  health: {
    phase: SessionCoordinationState["phase"];
    warnings: string[];
    polling:
      | Omit<TurnCoordinationState["polling"], "attempted_at" | "items">
      | null;
  };
  actor: {
    cell: string;
    role: string;
    persona: string | null;
    workspace: string | null;
    registration_epoch: string | null;
  };
  presence: {
    joined: true;
    started: boolean;
    attempts: number;
  };
  charter: BoundedText;
  goal: BoundedGoalView;
  publication: PublicationSnapshot | null;
  project: ProjectEnvironmentPacket | null;
  field: BoundedFieldView;
}

export interface CoordinationSystemPacket {
  text: string;
  messageIDs: string[];
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(value: string, maxBytes: number): BoundedText {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false };
  }
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { text: characters.slice(0, low).join(""), truncated: true };
}

function boundedMetadata(value: string | undefined): BoundedText | undefined {
  return value === undefined ? undefined : truncateUtf8(value, METADATA_MAX_BYTES);
}

function fitGoalItem(
  item: StickyGoalState["items"][number],
  maxBytes: number,
): BoundedGoalItem | undefined {
  const from = truncateUtf8(item.from, METADATA_MAX_BYTES);
  const file = boundedMetadata(item.file);
  const fromID = boundedMetadata(item.from_id);
  const topic = boundedMetadata(item.topic);
  const ts = boundedMetadata(item.ts);
  const thread = boundedMetadata(item.thread);
  const metadataTruncated = [from, file, fromID, topic, ts, thread].some(
    (entry) => entry?.truncated === true,
  );
  const characters = Array.from(item.body);
  const make = (length: number): BoundedGoalItem => ({
    from: from.text,
    body: characters.slice(0, length).join(""),
    ...(file === undefined ? {} : { file: file.text }),
    ...(fromID === undefined ? {} : { from_id: fromID.text }),
    ...(topic === undefined ? {} : { topic: topic.text }),
    ...(ts === undefined ? {} : { ts: ts.text }),
    ...(thread === undefined ? {} : { thread: thread.text }),
    body_truncated: length < characters.length,
    metadata_truncated: metadataTruncated,
  });
  if (jsonBytes(make(0)) > maxBytes) return undefined;

  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(make(middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return make(low);
}

function boundGoal(
  goal: StickyGoalState,
  freshness: TurnCoordinationState["goalFreshness"],
): BoundedGoalView {
  const items: BoundedGoalItem[] = [];
  const view = (): BoundedGoalView => ({
    status: goal.status,
    freshness,
    items,
    total: goal.items.length,
    omitted: goal.items.length - items.length,
    truncated:
      goal.items.length !== items.length ||
      items.some((item) => item.body_truncated || item.metadata_truncated),
  });

  for (const source of goal.items) {
    const remaining = GOAL_MAX_BYTES - jsonBytes(view()) - 1;
    if (remaining < 256) break;
    const item = fitGoalItem(source, remaining);
    if (item === undefined) continue;
    items.push(item);
    if (jsonBytes(view()) > GOAL_MAX_BYTES) items.pop();
  }
  return view();
}

function safeMetadata(value: string | null): string | null {
  return value === null ? null : truncateUtf8(value, METADATA_MAX_BYTES).text;
}

function pollingHealth(
  state: TurnCoordinationState,
): Omit<TurnCoordinationState["polling"], "attempted_at" | "items"> {
  const { attempted_at: _attemptedAt, items: _items, ...health } = state.polling;
  return {
    ...health,
    sources: {
      agora: { ...health.sources.agora },
      relay: { ...health.sources.relay },
      hub: { ...health.sources.hub },
      goal: { ...health.sources.goal },
    },
  };
}

export function buildCoordinationContextDocument(
  state: CoordinationContextState,
  project: ProjectEnvironmentPacket | null = null,
  publication: PublicationSnapshot | null = null,
): CoordinationContextDocument {
  const polled = "polling" in state;
  const fieldItems: SourcedFieldItem[] = polled
    ? state.polling.items
    : state.join.inbox.map((item) => ({
        ...item,
        source: "relay" as const,
        message_id: `relay:${item.file}`,
      }));
  const field = boundCoordinationItems(fieldItems, state.identity, {
    maxItems: COORDINATION_CONTEXT_MAX_ITEMS,
    maxItemBytes: COORDINATION_CONTEXT_MAX_ITEM_BYTES,
    maxTotalBytes: INBOX_MAX_BYTES,
  }) as BoundedFieldView;
  return {
    protocol: COORDINATION_CONTEXT_PROTOCOL,
    discipline: COORDINATION_DISCIPLINE,
    health: {
      phase: state.phase,
      warnings: state.warnings.map(
        (warning) => truncateUtf8(warning, 256).text,
      ),
      polling: polled ? pollingHealth(state) : null,
    },
    actor: {
      cell: state.identity,
      role: truncateUtf8(state.role, METADATA_MAX_BYTES).text,
      persona: safeMetadata(state.persona),
      workspace: safeMetadata(state.workspaceKey),
      registration_epoch: safeMetadata(state.registrationEpoch),
    },
    presence: {
      joined: true,
      started: state.join.started,
      attempts: state.attempts,
    },
    charter: truncateUtf8(state.join.charter, CHARTER_MAX_BYTES),
    goal: boundGoal(
      state.goal,
      polled
        ? state.goalFreshness
        : state.goal.status === "canonical"
          ? "fresh"
          : state.goal.status,
    ),
    publication,
    project,
    field,
  };
}

function render(document: CoordinationContextDocument): string {
  return [
    "<organum-coordination>",
    JSON.stringify(document, null, 2),
    "</organum-coordination>",
  ].join("\n");
}

/**
 * Rebuild the exact bounded packet from a supervisor-owned durable checkpoint.
 *
 * A restored document is never silently re-truncated: protocol drift or an
 * oversized checkpoint fails closed so compaction cannot weaken the context
 * contract.
 */
export function buildPersistedCoordinationSystemPacket(
  document: CoordinationContextDocument,
): CoordinationSystemPacket {
  if (document.protocol !== COORDINATION_CONTEXT_PROTOCOL) {
    throw new Error("Persisted coordination context protocol is incompatible");
  }
  const text = render(document);
  if (Buffer.byteLength(text, "utf8") > COORDINATION_CONTEXT_MAX_BYTES) {
    throw new Error("Persisted coordination context exceeds the packet byte limit");
  }
  return {
    text,
    messageIDs: document.field.items.map((item) => item.message_id),
  };
}

export function buildCoordinationSystemPacket(
  state: CoordinationContextState,
  project: ProjectEnvironmentPacket | null = null,
  publication: PublicationSnapshot | null = null,
): CoordinationSystemPacket {
  const document = buildCoordinationContextDocument(
    state,
    project,
    publication,
  );
  let output = render(document);

  while (
    Buffer.byteLength(output, "utf8") > COORDINATION_CONTEXT_MAX_BYTES &&
    document.field.items.length > 0
  ) {
    document.field.items.pop();
    document.field.omitted = document.field.total - document.field.items.length;
    document.field.truncated = true;
    output = render(document);
  }

  if (Buffer.byteLength(output, "utf8") > COORDINATION_CONTEXT_MAX_BYTES) {
    throw new Error("Bounded coordination context cannot fit its hard envelope");
  }
  return {
    text: output,
    messageIDs: document.field.items.map((item) => item.message_id),
  };
}

export function buildCoordinationSystemContext(
  state: CoordinationContextState,
  project: ProjectEnvironmentPacket | null = null,
  publication: PublicationSnapshot | null = null,
): string {
  return buildCoordinationSystemPacket(state, project, publication).text;
}
