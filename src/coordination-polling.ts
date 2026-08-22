import type {
  FieldItem,
  HubInboxPage,
  HubInboxRequest,
  HubItem,
  HubMemberBinding,
  HubReadReceipt,
  HubReadTarget,
  JoinGoal,
} from "./organum-cli.js";
import {
  classifyStickyGoal,
  type SessionCoordinationState,
  type StickyGoalState,
} from "./coordination-bootstrap.js";
import type { CellIdentity } from "./organum-identity.js";
import type { HubAdmissionLedger } from "./hub-admission-ledger.js";

const HUB_PAGE_LIMIT = 20;

export type CoordinationSource = "agora" | "relay" | "hub";
export type PollSourceStatus = "disabled" | "fresh" | "stale" | "unavailable";
export type PollingStatus = "fresh" | "partial" | "stale" | "unavailable";
export type GoalFreshness = "fresh" | "stale" | "unverified" | "missing";

export interface OrganumPollingClient {
  readAgora(identity: CellIdentity, signal?: AbortSignal): Promise<FieldItem[]>;
  readRelayInbox(
    identity: CellIdentity,
    signal?: AbortSignal,
  ): Promise<FieldItem[]>;
  readCurrentGoal(
    identity: CellIdentity,
    signal?: AbortSignal,
  ): Promise<JoinGoal | null>;
  markRelayRead?(
    identity: CellIdentity,
    file: string,
    signal?: AbortSignal,
  ): Promise<void>;
  readHubInbox?(request: HubInboxRequest): Promise<HubInboxPage>;
  markHubRead?(
    binding: HubMemberBinding,
    item: HubReadTarget,
    signal?: AbortSignal,
  ): Promise<HubReadReceipt>;
}

export interface SourcedFieldItem extends FieldItem {
  source: CoordinationSource;
  message_id: string;
}

export interface PollSourceHealth {
  status: PollSourceStatus;
  count: number;
  error: string | null;
}

export interface CoordinationPollingState {
  status: PollingStatus;
  attempted_at: string;
  sources: {
    agora: PollSourceHealth;
    relay: PollSourceHealth;
    hub: PollSourceHealth;
    goal: PollSourceHealth;
  };
  items: SourcedFieldItem[];
  seen_count: number;
  horizon: 200;
  saturated: boolean;
  hub_has_more: boolean;
  hub_pending_ack_count: number;
}

export interface TurnCoordinationState extends SessionCoordinationState {
  polling: CoordinationPollingState;
  goalFreshness: GoalFreshness;
}

interface RootPollEntry {
  identity: CellIdentity;
  hubBinding: HubMemberBinding | null;
  agora: FieldItem[];
  relay: FieldItem[];
  hub: HubItem[];
  agoraKnown: boolean;
  relayKnown: boolean;
  hubKnown: boolean;
  hubHasMore: boolean;
  hubAckError: string | null;
  hubAdmissionsLoaded: boolean;
  pendingHubAcks: Map<string, HubReadTarget>;
  canonicalGoal: StickyGoalState | null;
  goalKnown: boolean;
  seen: Set<string>;
  health: CoordinationPollingState;
  inFlight?: Promise<void>;
}

interface PendingAdmission {
  rootKey: string;
  messageIDs: string[];
  relayFiles: string[];
  hubItems: HubItem[];
}

function rootKey(directory: string, rootSessionID: string): string {
  return `${directory}\0${rootSessionID}`;
}

function sessionKey(directory: string, sessionID: string): string {
  return `${directory}\0${sessionID}`;
}

function localMessageID(source: "agora" | "relay", file: string): string {
  return `${source}:${file}`;
}

function hubMessageID(eventID: string): string {
  return `home-hub:${eventID}`;
}

function sourced(
  source: "agora" | "relay",
  item: FieldItem,
): SourcedFieldItem {
  return { ...item, source, message_id: localMessageID(source, item.file) };
}

function bindingFromState(
  state: SessionCoordinationState,
): HubMemberBinding | null {
  const registered = state.registrationEpoch !== null;
  if (
    registered !== (state.persona !== null) ||
    registered !== (state.workspaceKey !== null)
  ) {
    throw new Error("Hub registration state is incomplete");
  }
  const epoch = state.registrationEpoch;
  if (epoch === null) return null;
  if (epoch.trim().length === 0) {
    throw new Error("Hub registration epoch must be nonempty");
  }
  return { identity: state.identity, epoch };
}

function sameBinding(
  left: HubMemberBinding | null,
  right: HubMemberBinding | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.identity === right.identity && left.epoch === right.epoch;
}

function assertHubTarget(binding: HubMemberBinding, item: HubReadTarget): void {
  if (
    binding.epoch.trim().length === 0 ||
    item.to_id !== binding.identity ||
    item.to_epoch !== binding.epoch
  ) {
    throw new Error(
      "Hub item does not match the active cell and registration epoch",
    );
  }
}

function hubReadTarget(item: HubItem): HubReadTarget {
  return {
    file: item.file,
    event_id: item.event_id,
    to_id: item.to_id,
    to_epoch: item.to_epoch,
  };
}

function sourcedHub(
  binding: HubMemberBinding,
  item: HubItem,
): SourcedFieldItem {
  assertHubTarget(binding, item);
  return {
    file: item.file,
    from: item.from,
    from_id: item.from_id,
    to: item.to_id,
    topic: item.topic,
    thread: item.thread,
    in_reply_to: item.in_reply_to,
    idem: item.idem,
    ts: item.ts,
    escalate: false,
    body: item.body,
    source: "hub",
    message_id: hubMessageID(item.event_id),
  };
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "unknown polling error";
  const redacted = raw
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  const characters = Array.from(redacted);
  return characters.slice(0, 256).join("");
}

function initialHealth(hubEnabled: boolean): CoordinationPollingState {
  return {
    status: "unavailable",
    attempted_at: "",
    sources: {
      agora: { status: "unavailable", count: 0, error: null },
      relay: { status: "stale", count: 0, error: null },
      hub: {
        status: hubEnabled ? "unavailable" : "disabled",
        count: 0,
        error: null,
      },
      goal: { status: "unavailable", count: 0, error: null },
    },
    items: [],
    seen_count: 0,
    horizon: 200,
    saturated: false,
    hub_has_more: false,
    hub_pending_ack_count: 0,
  };
}

function sourceHealth(
  result: PromiseSettledResult<FieldItem[]>,
  knownBefore: boolean,
  currentCount: number,
): PollSourceHealth {
  if (result.status === "fulfilled") {
    return { status: "fresh", count: result.value.length, error: null };
  }
  return {
    status: knownBefore ? "stale" : "unavailable",
    count: currentCount,
    error: safeError(result.reason),
  };
}

function hubSourceHealth(
  result: PromiseSettledResult<HubInboxPage | null>,
  enabled: boolean,
  knownBefore: boolean,
  currentCount: number,
  ackError: string | null,
): PollSourceHealth {
  if (!enabled) return { status: "disabled", count: 0, error: null };
  if (result.status === "rejected") {
    return {
      status: knownBefore ? "stale" : "unavailable",
      count: currentCount,
      error: safeError(result.reason),
    };
  }
  if (result.value === null) {
    return {
      status: "unavailable",
      count: currentCount,
      error: "Hub inbox returned no page for an active registration",
    };
  }
  if (ackError !== null) {
    return { status: "stale", count: result.value.items.length, error: ackError };
  }
  return { status: "fresh", count: result.value.items.length, error: null };
}

function goalSourceHealth(
  result: PromiseSettledResult<JoinGoal | null>,
  knownBefore: boolean,
  currentCount: number,
): PollSourceHealth {
  if (result.status === "fulfilled") {
    return { status: "fresh", count: result.value === null ? 0 : 1, error: null };
  }
  return {
    status: knownBefore ? "stale" : "unavailable",
    count: currentCount,
    error: safeError(result.reason),
  };
}

function overallStatus(sources: readonly PollSourceHealth[]): PollingStatus {
  const enabled = sources.filter((source) => source.status !== "disabled");
  if (enabled.every((source) => source.status === "fresh")) return "fresh";
  if (enabled.some((source) => source.status === "fresh")) return "partial";
  if (enabled.some((source) => source.status === "stale")) return "stale";
  return "unavailable";
}

function uniqueItems(items: readonly SourcedFieldItem[]): SourcedFieldItem[] {
  const result = new Map<string, SourcedFieldItem>();
  for (const item of items) result.set(item.message_id, item);
  return [...result.values()];
}

export class SessionCoordinationPoller {
  private readonly roots = new Map<string, RootPollEntry>();
  private readonly pending = new Map<string, PendingAdmission>();

  constructor(
    private readonly organum: OrganumPollingClient,
    private readonly now: () => Date = () => new Date(),
    private readonly hubLedger?: HubAdmissionLedger,
  ) {}

  async poll(
    state: SessionCoordinationState,
    directory: string,
    signal?: AbortSignal,
  ): Promise<TurnCoordinationState> {
    const key = rootKey(directory, state.rootSessionID);
    const binding = bindingFromState(state);
    let entry = this.roots.get(key);
    if (entry === undefined) {
      entry = {
        identity: state.identity,
        hubBinding: binding,
        agora: [],
        relay: [...state.join.inbox],
        hub: [],
        agoraKnown: false,
        relayKnown: true,
        hubKnown: false,
        hubHasMore: false,
        hubAckError: null,
        hubAdmissionsLoaded: binding === null,
        pendingHubAcks: new Map<string, HubReadTarget>(),
        canonicalGoal: state.goal.status === "canonical" ? state.goal : null,
        goalKnown: state.goal.status !== "unverified",
        seen: new Set<string>(),
        health: initialHealth(binding !== null),
      };
      this.roots.set(key, entry);
    } else if (
      entry.identity !== state.identity ||
      !sameBinding(entry.hubBinding, binding)
    ) {
      throw new Error("Polling root identity or registration epoch changed unexpectedly");
    }

    if (entry.inFlight === undefined) {
      const current = entry;
      current.inFlight = this.refresh(current, signal).finally(() => {
        current.inFlight = undefined;
      });
    }
    await entry.inFlight;
    return this.forTurn(state, entry);
  }

  stage(
    sessionID: string,
    directory: string,
    state: TurnCoordinationState,
    messageIDs: readonly string[],
  ): void {
    const key = rootKey(directory, state.rootSessionID);
    const entry = this.roots.get(key);
    if (entry === undefined) throw new Error("Cannot stage an unknown polling root");
    const available = new Set(state.polling.items.map((item) => item.message_id));
    const admitted = [...new Set(messageIDs)].filter((id) => available.has(id));
    const admittedSet = new Set(admitted);
    const relayFiles = entry.relay
      .filter((item) => admittedSet.has(localMessageID("relay", item.file)))
      .map((item) => item.file);
    const hubItems = entry.hub.filter((item) =>
      admittedSet.has(hubMessageID(item.event_id)),
    );
    this.pending.set(sessionKey(directory, sessionID), {
      rootKey: key,
      messageIDs: admitted,
      relayFiles,
      hubItems: hubItems.map((item) => ({ ...item })),
    });
  }

  async admit(
    sessionID: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const key = sessionKey(directory, sessionID);
    const pending = this.pending.get(key);
    if (pending === undefined) return 0;
    const entry = this.roots.get(pending.rootKey);
    if (entry === undefined) return 0;
    if (
      pending.relayFiles.length > 0 &&
      this.organum.markRelayRead === undefined
    ) {
      throw new Error(
        "Organum relay semantic ACK is unavailable for an active delivery",
      );
    }
    for (const file of pending.relayFiles) {
      await this.organum.markRelayRead?.(entry.identity, file, signal);
    }
    if (pending.hubItems.length > 0) {
      if (entry.hubBinding === null || this.hubLedger === undefined) {
        throw new Error(
          "Durable hub admission ledger is unavailable for an active delivery",
        );
      }
      for (const item of pending.hubItems) {
        assertHubTarget(entry.hubBinding, item);
        await this.hubLedger.record(
          entry.hubBinding,
          hubReadTarget(item),
          this.now().toISOString(),
        );
        entry.seen.add(hubMessageID(item.event_id));
        entry.pendingHubAcks.set(hubMessageID(item.event_id), hubReadTarget(item));
      }
    }
    this.pending.delete(key);
    for (const id of pending.messageIDs) entry.seen.add(id);
    await this.flushHubAcks(entry, signal);
    return pending.messageIDs.length;
  }

  discard(sessionID: string, directory: string): void {
    this.pending.delete(sessionKey(directory, sessionID));
  }

  private async flushHubAcks(
    entry: RootPollEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    if (entry.pendingHubAcks.size === 0) {
      entry.hubAckError = null;
      return;
    }
    if (
      entry.hubBinding === null ||
      this.hubLedger === undefined ||
      this.organum.markHubRead === undefined
    ) {
      entry.hubAckError = "Hub semantic ACK is unavailable for an active delivery";
      return;
    }
    let failure: string | null = null;
    for (const [id, item] of entry.pendingHubAcks) {
      try {
        assertHubTarget(entry.hubBinding, item);
        await this.organum.markHubRead(entry.hubBinding, item, signal);
        await this.hubLedger.remove(entry.hubBinding, item);
        entry.pendingHubAcks.delete(id);
      } catch (error) {
        failure ??= `Hub semantic ACK pending: ${safeError(error)}`;
      }
    }
    entry.hubAckError = failure;
  }

  private async refresh(
    entry: RootPollEntry,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.restoreHubAdmissions(entry);
    } catch (error) {
      entry.hubAckError = `Hub durable admission unavailable: ${safeError(error)}`;
      const failedHub = Promise.reject(error) as Promise<HubInboxPage | null>;
      await this.refreshSources(entry, failedHub, signal);
      return;
    }
    await this.flushHubAcks(entry, signal);
    const hubPromise: Promise<HubInboxPage | null> =
      entry.hubBinding === null
        ? Promise.resolve(null)
        : this.organum.readHubInbox === undefined
          ? Promise.reject(new Error("Hub inbox adapter is unavailable"))
          : this.organum
              .readHubInbox({
                ...entry.hubBinding,
                limit: HUB_PAGE_LIMIT,
                signal,
              })
              .then((page) => {
                for (const item of page.items) {
                  assertHubTarget(entry.hubBinding as HubMemberBinding, item);
                }
                return page;
              });
    await this.refreshSources(entry, hubPromise, signal);
  }

  private async restoreHubAdmissions(entry: RootPollEntry): Promise<void> {
    if (entry.hubAdmissionsLoaded) return;
    if (entry.hubBinding === null) {
      entry.hubAdmissionsLoaded = true;
      return;
    }
    if (this.hubLedger === undefined) {
      throw new Error("Durable hub admission ledger is not configured");
    }
    const recovered = await this.hubLedger.load(entry.hubBinding);
    for (const admission of recovered) {
      assertHubTarget(entry.hubBinding, admission.target);
      const id = hubMessageID(admission.target.event_id);
      const existing = entry.pendingHubAcks.get(id);
      if (
        existing !== undefined &&
        (existing.file !== admission.target.file ||
          existing.to_id !== admission.target.to_id ||
          existing.to_epoch !== admission.target.to_epoch)
      ) {
        throw new Error("Durable hub admission conflicts with pending ACK state");
      }
      entry.seen.add(id);
      entry.pendingHubAcks.set(id, admission.target);
    }
    entry.hubAdmissionsLoaded = true;
  }

  private async refreshSources(
    entry: RootPollEntry,
    hubPromise: Promise<HubInboxPage | null>,
    signal?: AbortSignal,
  ): Promise<void> {
    const [agora, relay, hub, goal] = await Promise.allSettled([
      this.organum.readAgora(entry.identity, signal),
      this.organum.readRelayInbox(entry.identity, signal),
      hubPromise,
      this.organum.readCurrentGoal(entry.identity, signal).then((value) => {
        if (
          value !== null &&
          classifyStickyGoal([value]).status !== "canonical"
        ) {
          throw new Error("Current-goal lookup returned an incomplete envelope");
        }
        return value;
      }),
    ]);
    const agoraHealth = sourceHealth(
      agora,
      entry.agoraKnown,
      entry.agora.length,
    );
    const relayHealth = sourceHealth(
      relay,
      entry.relayKnown,
      entry.relay.length,
    );
    const hubHealth = hubSourceHealth(
      hub,
      entry.hubBinding !== null,
      entry.hubKnown,
      entry.hub.length,
      entry.hubAckError,
    );
    const goalHealth = goalSourceHealth(
      goal,
      entry.goalKnown,
      entry.canonicalGoal === null ? 0 : 1,
    );
    if (agora.status === "fulfilled") {
      entry.agora = agora.value;
      entry.agoraKnown = true;
    }
    if (relay.status === "fulfilled") {
      entry.relay = relay.value;
      entry.relayKnown = true;
    }
    if (hub.status === "fulfilled" && hub.value !== null) {
      entry.hub = hub.value.items;
      entry.hubKnown = true;
      entry.hubHasMore = hub.value.hasMore;
    }
    if (goal.status === "fulfilled") {
      entry.canonicalGoal =
        goal.value === null
          ? null
          : { status: "canonical", items: [{ ...goal.value }] };
      entry.goalKnown = true;
    }
    const saturated = entry.agora.length >= 200 || entry.relay.length >= 200;
    entry.health = {
      status: overallStatus([agoraHealth, relayHealth, hubHealth, goalHealth]),
      attempted_at: this.now().toISOString(),
      sources: {
        agora: agoraHealth,
        relay: relayHealth,
        hub: hubHealth,
        goal: goalHealth,
      },
      items: [],
      seen_count: entry.seen.size,
      horizon: 200,
      saturated,
      hub_has_more: entry.hubHasMore,
      hub_pending_ack_count: entry.pendingHubAcks.size,
    };
  }

  private forTurn(
    state: SessionCoordinationState,
    entry: RootPollEntry,
  ): TurnCoordinationState {
    const goal = entry.goalKnown
      ? entry.canonicalGoal ?? { status: "missing" as const, items: [] }
      : entry.canonicalGoal ?? state.goal;
    const goalFreshness: GoalFreshness =
      goal.status !== "canonical"
        ? goal.status
        : entry.health.sources.goal.status === "fresh"
          ? "fresh"
          : "stale";
    const hubItems =
      entry.hubBinding === null
        ? []
        : entry.hub.map((item) =>
            sourcedHub(entry.hubBinding as HubMemberBinding, item),
          );
    const items = uniqueItems([
      ...entry.relay.map((item) => sourced("relay", item)),
      ...hubItems,
      ...entry.agora.map((item) => sourced("agora", item)),
    ]).filter((item) => !entry.seen.has(item.message_id));
    const polling: CoordinationPollingState = {
      ...entry.health,
      sources: {
        agora: { ...entry.health.sources.agora },
        relay: { ...entry.health.sources.relay },
        hub: { ...entry.health.sources.hub },
        goal: { ...entry.health.sources.goal },
      },
      items,
      seen_count: entry.seen.size,
      hub_pending_ack_count: entry.pendingHubAcks.size,
    };
    const warnings = state.warnings.filter(
      (warning) =>
        !/canonical current goal|current-goal|backlog 5|R2 requires one full/i.test(
          warning,
        ),
    );
    if (goal.status === "missing") {
      warnings.push(
        "No canonical current goal is available; bootstrap remains degraded until one is published.",
      );
    } else if (goal.status === "unverified") {
      warnings.push(
        "Join goal is summary-only, incomplete, or ambiguous; R2 requires one full canonical current-goal envelope.",
      );
    }
    if (polling.status !== "fresh") {
      warnings.push(
        `Coordination polling is ${polling.status}; stale data is retained and failed sources will retry next turn.`,
      );
    }
    if (polling.saturated) {
      warnings.push(
        "Coordination public view reached the 200-item horizon; backlog 4 pagination is now a correctness blocker.",
      );
    }
    return {
      ...state,
      phase: warnings.length === 0 ? "ready" : "degraded",
      goal,
      warnings,
      polling,
      goalFreshness,
    };
  }

  clear(): void {
    this.roots.clear();
    this.pending.clear();
  }
}
