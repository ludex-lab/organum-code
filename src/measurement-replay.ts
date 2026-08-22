import { isAbsolute, join, resolve } from "node:path";

export const MEASUREMENT_REPLAY_PROTOCOL = 1;

export interface MeasurementReplayDefinition {
  organum_commit: string;
  organum_version: string;
  opencode_version: string;
  bun_version: string;
  persona: string;
  workspace: string;
  intent: string;
  settle_seconds: number;
  field_live_window_minutes: number;
  observatory_window_days: number;
  two_lens_fields: string[];
  success_state: string;
  forbidden_state: string;
  baseline_observatory_file: string;
  bench_document: string;
  effect_matrix_document: string;
}

export interface MeasurementReplayPaths {
  project: string;
  hubDirectory: string;
  xdgData: string;
  xdgCache: string;
  xdgState: string;
  goFile: string;
  readinessFile: string;
  resultFile: string;
}

export interface MeasurementCommand {
  cwd: string;
  env: Record<string, string>;
  argv: string[];
}

export interface MeasurementReadiness {
  protocol: 1;
  mode: "measurement-grade-replay";
  provider_requests_started: false;
  actor: {
    provider: "upstage";
    model: "solar-open2";
    role: "critic";
    persona: string;
    workspace: string;
  };
  environment_pins: {
    warren_commit: string;
    organum_commit: string;
    organum_version: string;
    opencode_version: string;
    bun_version: string;
  };
  exact_actor_environment: Record<string, string>;
  observer: {
    settle_seconds: number;
    field_live_window_minutes: number;
    two_lens_fields: string[];
    success_state: string;
    forbidden_state: string;
    commands: {
      web: MeasurementCommand;
      roster: MeasurementCommand;
      observatory_sync: MeasurementCommand;
      observatory_stats: MeasurementCommand;
      observatory_report: MeasurementCommand;
    };
    peer_journal: {
      recorded_by: ["chief", "JJ"];
      peer: "canonical-solar-cell-from-result";
      required_fields: [
        "peer",
        "strengths",
        "frictions",
        "would_pair_again",
        "role_fit",
      ];
      optional_fields: ["direction"];
      allowed_directions: ["downward", "peer"];
      argv_template: string[];
    };
  };
  comparison: {
    source_session_id: string;
    baseline_observatory_file: string;
    bench_document: string;
    effect_matrix_document: string;
    primary_axis: "durable-field-contribution";
    token_delta_is_causal: false;
  };
  go: {
    file: string;
    signal: "create-empty-file";
    provider_requests_before_signal: 0;
  };
  paths: MeasurementReplayPaths;
}

function nonempty(value: string, field: string): string {
  if (
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new Error(`Measurement replay ${field} is invalid`);
  }
  return value;
}

function canonicalLabel(value: string, field: string): string {
  const label = nonempty(value, field).toLowerCase();
  if (!/^[a-z0-9_-][a-z0-9._-]{0,39}$/.test(label) || label.endsWith(".")) {
    throw new Error(`Measurement replay ${field} is not canonical`);
  }
  return label;
}

function absolute(path: string, field: string): string {
  if (path.includes("\0") || !isAbsolute(path)) {
    throw new Error(`Measurement replay ${field} must be an absolute path`);
  }
  return resolve(path);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Measurement replay ${field} must be a positive integer`);
  }
  return value;
}

export function buildMeasurementReadiness(input: {
  definition: MeasurementReplayDefinition;
  paths: MeasurementReplayPaths;
  organumBinary: string;
  openCodeBinary: string;
  sourceCommit: string;
  sourceSessionID: string;
}): MeasurementReadiness {
  const persona = canonicalLabel(input.definition.persona, "persona");
  const workspace = canonicalLabel(input.definition.workspace, "workspace");
  const intent = nonempty(input.definition.intent, "intent");
  const settleSeconds = positiveInteger(
    input.definition.settle_seconds,
    "settle_seconds",
  );
  const fieldLiveWindowMinutes = positiveInteger(
    input.definition.field_live_window_minutes,
    "field_live_window_minutes",
  );
  const windowDays = positiveInteger(
    input.definition.observatory_window_days,
    "observatory_window_days",
  );
  const paths: MeasurementReplayPaths = {
    project: absolute(input.paths.project, "project"),
    hubDirectory: absolute(input.paths.hubDirectory, "hubDirectory"),
    xdgData: absolute(input.paths.xdgData, "xdgData"),
    xdgCache: absolute(input.paths.xdgCache, "xdgCache"),
    xdgState: absolute(input.paths.xdgState, "xdgState"),
    goFile: absolute(input.paths.goFile, "goFile"),
    readinessFile: absolute(input.paths.readinessFile, "readinessFile"),
    resultFile: absolute(input.paths.resultFile, "resultFile"),
  };
  const organumBinary = nonempty(input.organumBinary, "organumBinary");
  const openCodeBinary = nonempty(input.openCodeBinary, "openCodeBinary");
  const sourceCommit = nonempty(input.sourceCommit, "sourceCommit");
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error("Measurement replay sourceCommit must be a full commit");
  }
  const observerEnvironment = {
    ORGANUM_HUB: paths.hubDirectory,
    OPENCODE_DATA_DIR: join(paths.xdgData, "opencode"),
    XDG_DATA_HOME: paths.xdgData,
    XDG_CACHE_HOME: paths.xdgCache,
    XDG_STATE_HOME: paths.xdgState,
  };
  const command = (argv: string[]): MeasurementCommand => ({
    cwd: paths.project,
    env: { ...observerEnvironment },
    argv: [organumBinary, ...argv],
  });
  const exactActorEnvironment = {
    ORGANUM_CODE_API_KEY_ENV: "UPSTAGE_API_KEY",
    ORGANUM_CODE_BASE_URL: "https://api.upstage.ai/v1",
    ORGANUM_CODE_MODEL: "solar-open2",
    ORGANUM_CODE_MODEL_NAME: "Solar Open 2",
    ORGANUM_CODE_PROVIDER_ID: "upstage",
    ORGANUM_CODE_PROVIDER_NAME: "Upstage Solar",
    ORGANUM_CODE_ROLE: "critic",
    ORGANUM_CODE_PERSONA: persona,
    ORGANUM_CODE_WORKSPACE: workspace,
    ORGANUM_CODE_HUB_DIR: paths.hubDirectory,
    ORGANUM_CODE_STATE_DIR: join(paths.xdgState, "organum-code"),
    ORGANUM_CODE_INTENT: intent,
    ORGANUM_CODE_ORGANUM_BIN: organumBinary,
    ORGANUM_CODE_OPENCODE_BIN: openCodeBinary,
    ORGANUM_CODE_PROJECT_CONTRACT: ".organum/roles/critic.md",
  };
  return {
    protocol: MEASUREMENT_REPLAY_PROTOCOL,
    mode: "measurement-grade-replay",
    provider_requests_started: false,
    actor: {
      provider: "upstage",
      model: "solar-open2",
      role: "critic",
      persona,
      workspace,
    },
    environment_pins: {
      warren_commit: sourceCommit,
      organum_commit: nonempty(
        input.definition.organum_commit,
        "organum_commit",
      ),
      organum_version: nonempty(
        input.definition.organum_version,
        "organum_version",
      ),
      opencode_version: nonempty(
        input.definition.opencode_version,
        "opencode_version",
      ),
      bun_version: nonempty(input.definition.bun_version, "bun_version"),
    },
    exact_actor_environment: exactActorEnvironment,
    observer: {
      settle_seconds: settleSeconds,
      field_live_window_minutes: fieldLiveWindowMinutes,
      two_lens_fields: input.definition.two_lens_fields.map((field) =>
        nonempty(field, "two_lens_fields"),
      ),
      success_state: nonempty(input.definition.success_state, "success_state"),
      forbidden_state: nonempty(
        input.definition.forbidden_state,
        "forbidden_state",
      ),
      commands: {
        web: command(["web"]),
        roster: command(["roster"]),
        observatory_sync: command([
          "observatory",
          "sync",
          "--window",
          String(windowDays),
        ]),
        observatory_stats: command([
          "observatory",
          "stats",
          "--by",
          "model",
        ]),
        observatory_report: command(["observatory", "report"]),
      },
      peer_journal: {
        recorded_by: ["chief", "JJ"],
        peer: "canonical-solar-cell-from-result",
        required_fields: [
          "peer",
          "strengths",
          "frictions",
          "would_pair_again",
          "role_fit",
        ],
        optional_fields: ["direction"],
        allowed_directions: ["downward", "peer"],
        argv_template: [
          organumBinary,
          "session",
          "end",
          "--for",
          "<observer-cell>",
          "--peer-json",
          "<five-field-json>",
        ],
      },
    },
    comparison: {
      source_session_id: nonempty(input.sourceSessionID, "sourceSessionID"),
      baseline_observatory_file: nonempty(
        input.definition.baseline_observatory_file,
        "baseline_observatory_file",
      ),
      bench_document: nonempty(
        input.definition.bench_document,
        "bench_document",
      ),
      effect_matrix_document: nonempty(
        input.definition.effect_matrix_document,
        "effect_matrix_document",
      ),
      primary_axis: "durable-field-contribution",
      token_delta_is_causal: false,
    },
    go: {
      file: paths.goFile,
      signal: "create-empty-file",
      provider_requests_before_signal: 0,
    },
    paths,
  };
}
