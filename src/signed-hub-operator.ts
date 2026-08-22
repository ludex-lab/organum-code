import { dirname } from "node:path";

import type { AllocatedActorRuntime } from "./actor-runtime.js";
import {
  SignedHubLifecycle,
  SignedHubNoTurnError,
  loadSignedHubTurn,
  type SignedHubTurn,
} from "./grok-acp-signed-hub.js";
import {
  runHubSupervisorDoctor,
  type HubSupervisorDoctorReport,
} from "./hub-supervisor-doctor.js";
import { ConfigurationError } from "./provider-profile.js";
import {
  FileSignedHubSupervisorStore,
  parseCanonicalHubMessage,
  type SignedHubSupervisorPhase,
  type SignedHubSupervisorRecord,
} from "./signed-hub-supervisor.js";

export const SIGNED_HUB_OPERATOR_REPORT_SCHEMA =
  "organum-code/signed-hub-operator-report/v1" as const;

export type SignedHubOperatorOperation = "setup" | "status" | "recover";
export type SignedHubOperatorBackend =
  | "grok"
  | "claude"
  | "codex"
  | "deepcode"
  | "cursor";
export interface SignedHubOperatorCommand {
  operation: SignedHubOperatorOperation;
  backend: SignedHubOperatorBackend;
}
export type SignedHubOperatorDisposition =
  | "ready"
  | "recovered_ack"
  | "already_acked"
  | "reconciliation_required"
  | "no_state"
  | "runtime_unhealthy"
  | "status_ok";

export interface SignedHubOperatorRecord {
  event_id: string;
  phase: SignedHubSupervisorPhase;
  accepted_seq: number;
  semantic_outcome: SignedHubSupervisorRecord["semantic_outcome"];
  ack_event_id: string | null;
  ack_accepted_seq: number | null;
  target: SignedHubSupervisorRecord["target"];
}

export interface SignedHubOperatorReport {
  schema: typeof SIGNED_HUB_OPERATOR_REPORT_SCHEMA;
  operation: SignedHubOperatorOperation;
  disposition: SignedHubOperatorDisposition;
  provider_requests: 0;
  actor: string;
  backend: AllocatedActorRuntime["backend"];
  event_id: string | null;
  doctor: {
    configured: boolean;
    healthy: boolean;
    runtime: HubSupervisorDoctorReport["checks"]["runtime"]["status"];
    replay: HubSupervisorDoctorReport["checks"]["hubReplay"]["status"];
  };
  counts: Record<SignedHubSupervisorPhase, number>;
  records: SignedHubOperatorRecord[];
}

export interface SignedHubOperatorResult {
  exitCode: 0 | 2;
  report: SignedHubOperatorReport;
}

export interface SignedHubOperatorDependencies {
  loadTurn?: typeof loadSignedHubTurn;
  doctor?: typeof runHubSupervisorDoctor;
}

export function parseSignedHubOperatorCommand(
  args: readonly string[],
): SignedHubOperatorCommand | null {
  if (args[0] !== "hub") return null;
  const operation = args[1];
  if (operation !== "setup" && operation !== "status" && operation !== "recover") {
    throw new ConfigurationError(
      "hub requires one operation: setup, status, or recover",
    );
  }
  if (args.length === 2) return { operation, backend: "grok" };
  if (
    args.length === 4 &&
    args[2] === "--backend" &&
    (
      args[3] === "grok" ||
      args[3] === "claude" ||
      args[3] === "codex" ||
      args[3] === "deepcode" ||
      args[3] === "cursor"
    )
  ) {
    return { operation, backend: args[3] };
  }
  throw new ConfigurationError(
    "hub accepts only an optional `--backend grok|claude|codex|deepcode|cursor` selector",
  );
}

function projectRecord(record: SignedHubSupervisorRecord): SignedHubOperatorRecord {
  return {
    event_id: record.event_id,
    phase: record.phase,
    accepted_seq: record.accepted_seq,
    semantic_outcome: record.semantic_outcome,
    ack_event_id: record.ack_event_id,
    ack_accepted_seq: record.ack_accepted_seq,
    target: { ...record.target },
  };
}

function counts(records: readonly SignedHubSupervisorRecord[]): Record<
  SignedHubSupervisorPhase,
  number
> {
  const result = { prepared: 0, in_flight: 0, ack_pending: 0, acked: 0 };
  for (const record of records) result[record.phase] += 1;
  return result;
}

function report(
  operation: SignedHubOperatorOperation,
  disposition: SignedHubOperatorDisposition,
  actorRuntime: AllocatedActorRuntime,
  doctor: HubSupervisorDoctorReport,
  records: readonly SignedHubSupervisorRecord[],
  eventID: string | null,
): SignedHubOperatorReport {
  return {
    schema: SIGNED_HUB_OPERATOR_REPORT_SCHEMA,
    operation,
    disposition,
    provider_requests: 0,
    actor: actorRuntime.actor,
    backend: actorRuntime.backend,
    event_id: eventID,
    doctor: {
      configured: doctor.configured,
      healthy: doctor.healthy,
      runtime: doctor.checks.runtime.status,
      replay: doctor.checks.hubReplay.status,
    },
    counts: counts(records),
    records: records.map(projectRecord),
  };
}

async function runtimeReport(
  options: SignedHubOperatorOptions,
): Promise<HubSupervisorDoctorReport> {
  return await (options.dependencies?.doctor ?? runHubSupervisorDoctor)({
    env: options.environment,
    cwd: options.directory,
  });
}

async function currentRecords(
  actorRuntime: AllocatedActorRuntime,
): Promise<SignedHubSupervisorRecord[]> {
  return await new FileSignedHubSupervisorStore(
    dirname(actorRuntime.bindingPath),
  ).list();
}

async function loadTurn(
  options: SignedHubOperatorOptions,
): Promise<SignedHubTurn> {
  return await (options.dependencies?.loadTurn ?? loadSignedHubTurn)({
    environment: options.environment,
    directory: options.directory,
    actorRuntime: options.actorRuntime,
  });
}

export interface SignedHubOperatorOptions {
  operation: SignedHubOperatorOperation;
  environment: NodeJS.ProcessEnv;
  directory: string;
  actorRuntime: AllocatedActorRuntime;
  dependencies?: SignedHubOperatorDependencies;
}

export async function runSignedHubOperator(
  options: SignedHubOperatorOptions,
): Promise<SignedHubOperatorResult> {
  const doctor = await runtimeReport(options);
  if (options.operation === "status") {
    const records = await currentRecords(options.actorRuntime);
    const reconciliation = records.some(
      (record) => record.phase === "in_flight",
    );
    const attention = reconciliation || !doctor.healthy;
    return {
      exitCode: attention ? 2 : 0,
      report: report(
        "status",
        !doctor.healthy
          ? "runtime_unhealthy"
          : reconciliation
            ? "reconciliation_required"
            : "status_ok",
        options.actorRuntime,
        doctor,
        records,
        null,
      ),
    };
  }
  if (!doctor.healthy) {
    const records = await currentRecords(options.actorRuntime);
    return {
      exitCode: 2,
      report: report(
        options.operation,
        "runtime_unhealthy",
        options.actorRuntime,
        doctor,
        records,
        null,
      ),
    };
  }

  const turn = await loadTurn(options);
  const eventID = parseCanonicalHubMessage(turn.candidate.envelope).eventID;
  if (options.operation === "recover") {
    const existing = await turn.supervisor.inspect(eventID);
    if (existing === null) {
      return {
        exitCode: 2,
        report: report(
          "recover",
          "no_state",
          options.actorRuntime,
          doctor,
          await turn.supervisor.records(),
          eventID,
        ),
      };
    }
    if (existing.phase === "in_flight") {
      return {
        exitCode: 2,
        report: report(
          "recover",
          "reconciliation_required",
          options.actorRuntime,
          doctor,
          await turn.supervisor.records(),
          eventID,
        ),
      };
    }
    if (existing.phase === "ack_pending") {
      await turn.supervisor.emitPendingAck(eventID);
      return {
        exitCode: 0,
        report: report(
          "recover",
          "recovered_ack",
          options.actorRuntime,
          doctor,
          await turn.supervisor.records(),
          eventID,
        ),
      };
    }
    return {
      exitCode: 0,
      report: report(
        "recover",
        existing.phase === "acked" ? "already_acked" : "ready",
        options.actorRuntime,
        doctor,
        await turn.supervisor.records(),
        eventID,
      ),
    };
  }

  try {
    await new SignedHubLifecycle(turn).prepare();
  } catch (error) {
    if (!(error instanceof SignedHubNoTurnError)) throw error;
    const disposition =
      error.disposition === "ack_recovered"
        ? "recovered_ack"
        : error.disposition === "already_acked"
          ? "already_acked"
          : "reconciliation_required";
    return {
      exitCode: disposition === "reconciliation_required" ? 2 : 0,
      report: report(
        "setup",
        disposition,
        options.actorRuntime,
        doctor,
        await turn.supervisor.records(),
        eventID,
      ),
    };
  }
  return {
    exitCode: 0,
    report: report(
      "setup",
      "ready",
      options.actorRuntime,
      doctor,
      await turn.supervisor.records(),
      eventID,
    ),
  };
}
