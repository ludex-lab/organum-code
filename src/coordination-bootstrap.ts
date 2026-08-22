import {
  type JoinGoal,
  type JoinResult,
  type OrganumJoinRequest,
} from "./organum-cli.js";
import { deriveCellIdentity, type CellIdentity } from "./organum-identity.js";
import {
  type RootSessionResolver,
  type RootSessionResolution,
} from "./backend-session.js";

export interface OrganumJoinClient {
  join(request: OrganumJoinRequest): Promise<JoinResult>;
}

export type CellIdentityDeriver = (rootSessionID: string) => CellIdentity;

export type StickyGoalStatus = "canonical" | "missing" | "unverified";
export type BootstrapPhase = "degraded" | "ready";

export interface StickyGoalState {
  status: StickyGoalStatus;
  items: JoinGoal[];
}

export interface RootCoordinationState {
  rootSessionID: string;
  identity: CellIdentity;
  role: string;
  persona: string | null;
  workspaceKey: string | null;
  registrationEpoch: string | null;
  phase: BootstrapPhase;
  attempts: number;
  join: JoinResult;
  goal: StickyGoalState;
  warnings: string[];
}

export interface SessionCoordinationState extends RootCoordinationState {
  lineage: string[];
}

export interface BootstrapSessionRequest {
  sessionID: string;
  directory: string;
  role: string;
  intent?: string;
  persona?: string;
  workspace?: string;
  loadout?: string;
  problemType?: string;
  signal?: AbortSignal;
}

export class CoordinationBootstrapError extends Error {
  constructor(
    message: string,
    readonly kind: "conflict" | "contract",
  ) {
    super(message);
    this.name = "CoordinationBootstrapError";
  }
}

interface RootEntry {
  signature: string;
  promise: Promise<RootCoordinationState>;
}

function nonempty(value: string, context: string): string {
  if (value.trim().length === 0) {
    throw new CoordinationBootstrapError(`${context} must not be empty`, "contract");
  }
  return value;
}

function optionalCanonical(value: string | undefined): string | null {
  return value === undefined ? null : value.toLowerCase();
}

function requestSignature(request: BootstrapSessionRequest): string {
  return JSON.stringify({
    role: request.role,
    intent: request.intent ?? null,
    persona: optionalCanonical(request.persona),
    workspace: optionalCanonical(request.workspace),
  });
}

function rootKey(directory: string, rootSessionID: string): string {
  return `${directory}\0${rootSessionID}`;
}

function canonicalGoal(item: JoinGoal): boolean {
  return (
    item.file !== undefined &&
    item.file.length > 0 &&
    item.from.trim().length > 0 &&
    item.from_id !== undefined &&
    item.from_id.length > 0 &&
    item.topic === "goal" &&
    item.ts !== undefined &&
    item.ts.trim().length > 0 &&
    item.thread !== undefined
  );
}

export function classifyStickyGoal(items: readonly JoinGoal[]): StickyGoalState {
  if (items.length === 0) return { status: "missing", items: [] };
  return {
    status: items.length === 1 && canonicalGoal(items[0])
      ? "canonical"
      : "unverified",
    items: items.map((item) => ({ ...item })),
  };
}

function warningsFor(goal: StickyGoalState): string[] {
  if (goal.status === "canonical") return [];
  if (goal.status === "missing") {
    return [
      "No canonical current goal is available; bootstrap remains degraded until one is published.",
    ];
  }
  return [
    "Join goal is summary-only, incomplete, or ambiguous; R2 requires one full canonical current-goal envelope.",
  ];
}

export class SessionCoordinationBootstrapper {
  private readonly entries = new Map<string, RootEntry>();
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly roots: RootSessionResolver,
    private readonly organum: OrganumJoinClient,
    private readonly deriveIdentity: CellIdentityDeriver = deriveCellIdentity,
  ) {}

  async ensure(request: BootstrapSessionRequest): Promise<SessionCoordinationState> {
    nonempty(request.sessionID, "Backend session ID");
    nonempty(request.directory, "Backend session directory");
    nonempty(request.role, "Organum role");
    if (request.workspace !== undefined && request.persona === undefined) {
      throw new CoordinationBootstrapError(
        "Organum workspace requires an explicit persona",
        "contract",
      );
    }

    const resolution = await this.roots.resolve(
      request.sessionID,
      request.directory,
      request.signal,
    );
    const key = rootKey(request.directory, resolution.rootSessionID);
    const signature = requestSignature(request);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing.signature !== signature) {
        throw new CoordinationBootstrapError(
          "Backend root session already has a different coordination declaration",
          "conflict",
        );
      }
      return this.forSession(await existing.promise, resolution);
    }

    const attempts = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempts);
    const identity = this.deriveIdentity(resolution.rootSessionID);
    const promise = this.bootstrapRoot(request, resolution, identity, attempts);
    const entry = { signature, promise };
    this.entries.set(key, entry);
    try {
      return this.forSession(await promise, resolution);
    } catch (error) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }
  }

  private async bootstrapRoot(
    request: BootstrapSessionRequest,
    resolution: RootSessionResolution,
    identity: CellIdentity,
    attempts: number,
  ): Promise<RootCoordinationState> {
    const join = await this.organum.join({
      identity,
      role: request.role,
      intent: request.intent,
      persona: request.persona,
      workspace: request.workspace,
      loadout: request.loadout,
      problemType: request.problemType,
      signal: request.signal,
    });
    const goal = classifyStickyGoal(join.goal);
    const warnings = warningsFor(goal);
    return {
      rootSessionID: resolution.rootSessionID,
      identity,
      role: request.role,
      persona: join.persona,
      workspaceKey: join.workspace?.key ?? null,
      registrationEpoch: join.registration?.epoch ?? null,
      phase: warnings.length === 0 ? "ready" : "degraded",
      attempts,
      join,
      goal,
      warnings,
    };
  }

  private forSession(
    state: RootCoordinationState,
    resolution: RootSessionResolution,
  ): SessionCoordinationState {
    return {
      ...state,
      lineage: [...resolution.lineage],
    };
  }

  clear(): void {
    this.entries.clear();
    this.attempts.clear();
  }
}
