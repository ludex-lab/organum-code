import { isAbsolute, resolve } from "node:path";

import type { OrganumCommandExecutor } from "./organum-cli.js";
import {
  ORGANUM_CODE_SIGNED_HUB_BIN_ENV,
  ORGANUM_CODE_SIGNED_HUB_CARRIER_TOKEN_ENV,
  ORGANUM_CODE_SIGNED_HUB_DIR_ENV,
  ORGANUM_CODE_SIGNED_HUB_PIN,
  ORGANUM_CODE_SIGNED_HUB_PROTOCOL_ENV,
  ORGANUM_CODE_SIGNED_HUB_WIRE_URL_ENV,
  OrganumHubCliAuthority,
} from "./organum-hub-cli.js";

export const HUB_SUPERVISOR_DOCTOR_SCHEMA =
  "organum-code/hub-supervisor-doctor/v1" as const;

export type HubWireDoctorStatus =
  | "ok"
  | "unconfigured"
  | "wire_unreachable";
export type HubCarrierAuthDoctorStatus =
  | "ok"
  | "unconfigured"
  | "carrier_auth_lost"
  | "carrier_auth_unknown";
export type HubReplayDoctorStatus =
  | "ok"
  | "unconfigured"
  | "hub_replay_failed";
export type HubRuntimeDoctorStatus =
  | "ok"
  | "unconfigured"
  | "runtime_drift";

export interface HubDoctorCheck<Status extends string> {
  status: Status;
  detail: string;
}

export interface HubSupervisorDoctorReport {
  schema: typeof HUB_SUPERVISOR_DOCTOR_SCHEMA;
  configured: boolean;
  healthy: boolean;
  protocolPin: typeof ORGANUM_CODE_SIGNED_HUB_PIN;
  checks: {
    wire: HubDoctorCheck<HubWireDoctorStatus>;
    carrierAuth: HubDoctorCheck<HubCarrierAuthDoctorStatus>;
    hubReplay: HubDoctorCheck<HubReplayDoctorStatus>;
    runtime: HubDoctorCheck<HubRuntimeDoctorStatus>;
  };
}

export interface HubSupervisorDoctorOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  executor?: OrganumCommandExecutor;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function configuredValue(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function unconfiguredReport(): HubSupervisorDoctorReport {
  return {
    schema: HUB_SUPERVISOR_DOCTOR_SCHEMA,
    configured: false,
    healthy: true,
    protocolPin: ORGANUM_CODE_SIGNED_HUB_PIN,
    checks: {
      wire: {
        status: "unconfigured",
        detail: "signed Hub wire is not configured",
      },
      carrierAuth: {
        status: "unconfigured",
        detail: "signed Hub carrier authentication is not configured",
      },
      hubReplay: {
        status: "unconfigured",
        detail: "signed Hub directory is not configured",
      },
      runtime: {
        status: "unconfigured",
        detail: "signed Hub runtime is not configured",
      },
    },
  };
}

function validWireURL(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function permitsCredential(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]"
  );
}

async function inspectWire(
  rawURL: string | undefined,
  token: string | undefined,
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<{
  wire: HubDoctorCheck<HubWireDoctorStatus>;
  carrierAuth: HubDoctorCheck<HubCarrierAuthDoctorStatus>;
}> {
  if (rawURL === undefined) {
    return {
      wire: {
        status: token === undefined ? "unconfigured" : "wire_unreachable",
        detail:
          token === undefined
            ? "signed Hub wire is not configured"
            : "carrier credential is configured without a wire URL",
      },
      carrierAuth: {
        status: token === undefined ? "unconfigured" : "carrier_auth_unknown",
        detail:
          token === undefined
            ? "signed Hub carrier authentication is not configured"
            : "carrier authority cannot be checked without a wire URL",
      },
    };
  }
  const url = validWireURL(rawURL);
  if (url === null) {
    return {
      wire: {
        status: "wire_unreachable",
        detail: "signed Hub wire URL is invalid",
      },
      carrierAuth: {
        status: token === undefined ? "unconfigured" : "carrier_auth_unknown",
        detail:
          token === undefined
            ? "carrier authentication is not configured"
            : "carrier authority cannot be checked against an invalid URL",
      },
    };
  }
  if (token !== undefined && !permitsCredential(url)) {
    return {
      wire: {
        status: "wire_unreachable",
        detail: "carrier credentials require HTTPS or a loopback endpoint",
      },
      carrierAuth: {
        status: "carrier_auth_unknown",
        detail: "carrier authority was not sent over an insecure wire",
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers:
        token === undefined ? undefined : { authorization: `Bearer ${token}` },
    });
    await response.body?.cancel().catch(() => undefined);
    const wire: HubDoctorCheck<HubWireDoctorStatus> = {
      status: "ok",
      detail: `carrier responded with HTTP ${response.status}`,
    };
    if (token === undefined) {
      return {
        wire,
        carrierAuth: {
          status: "unconfigured",
          detail: "carrier credential is not configured",
        },
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        wire,
        carrierAuth: {
          status: "carrier_auth_lost",
          detail: `carrier rejected the configured authority with HTTP ${response.status}`,
        },
      };
    }
    if (response.ok) {
      return {
        wire,
        carrierAuth: {
          status: "ok",
          detail: "carrier accepted the configured authority",
        },
      };
    }
    return {
      wire,
      carrierAuth: {
        status: "carrier_auth_unknown",
        detail: `carrier authority is indeterminate after HTTP ${response.status}`,
      },
    };
  } catch {
    return {
      wire: {
        status: "wire_unreachable",
        detail: "signed Hub wire request failed or timed out",
      },
      carrierAuth: {
        status: token === undefined ? "unconfigured" : "carrier_auth_unknown",
        detail:
          token === undefined
            ? "carrier credential is not configured"
            : "carrier authority cannot be checked while the wire is unreachable",
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function runHubSupervisorDoctor(
  options: HubSupervisorDoctorOptions = {},
): Promise<HubSupervisorDoctorReport> {
  const env = options.env ?? process.env;
  const hubDirectory = configuredValue(env, ORGANUM_CODE_SIGNED_HUB_DIR_ENV);
  const binary = configuredValue(env, ORGANUM_CODE_SIGNED_HUB_BIN_ENV);
  const protocol = configuredValue(env, ORGANUM_CODE_SIGNED_HUB_PROTOCOL_ENV);
  const wireURL = configuredValue(env, ORGANUM_CODE_SIGNED_HUB_WIRE_URL_ENV);
  const carrierToken = configuredValue(
    env,
    ORGANUM_CODE_SIGNED_HUB_CARRIER_TOKEN_ENV,
  );
  const configured =
    hubDirectory !== undefined ||
    binary !== undefined ||
    protocol !== undefined ||
    wireURL !== undefined ||
    carrierToken !== undefined;
  if (!configured) return unconfiguredReport();

  let runtime: HubDoctorCheck<HubRuntimeDoctorStatus>;
  let hubReplay: HubDoctorCheck<HubReplayDoctorStatus>;
  if (
    hubDirectory === undefined ||
    !isAbsolute(hubDirectory) ||
    hubDirectory.includes("\0")
  ) {
    runtime = {
      status: "runtime_drift",
      detail: "signed Hub directory is missing or is not absolute",
    };
    hubReplay = {
      status: "hub_replay_failed",
      detail: "signed Hub replay has no valid directory",
    };
  } else if (protocol !== ORGANUM_CODE_SIGNED_HUB_PIN) {
    runtime = {
      status: "runtime_drift",
      detail:
        protocol === undefined
          ? `signed Hub protocol pin ${ORGANUM_CODE_SIGNED_HUB_PIN} is not declared`
          : `configured Hub protocol does not match pin ${ORGANUM_CODE_SIGNED_HUB_PIN}`,
    };
    hubReplay = {
      status: "hub_replay_failed",
      detail: "Hub replay was not trusted under a mismatched protocol pin",
    };
  } else {
    const authority = new OrganumHubCliAuthority({
      hubDirectory: resolve(hubDirectory),
      binary,
      cwd: options.cwd,
      env,
      timeoutMs: options.timeoutMs,
      executor: options.executor,
    });
    try {
      await authority.inspectRuntime();
      runtime = {
        status: "ok",
        detail: `declared pin ${ORGANUM_CODE_SIGNED_HUB_PIN} and required CLI surface are available`,
      };
    } catch {
      runtime = {
        status: "runtime_drift",
        detail: "organum-hub runtime is unavailable or incompatible",
      };
    }
    try {
      await authority.replay();
      hubReplay = {
        status: "ok",
        detail: "local signed Hub log replay completed",
      };
    } catch {
      hubReplay = {
        status: "hub_replay_failed",
        detail: "local signed Hub log replay failed",
      };
    }
  }

  const carrier = await inspectWire(
    wireURL,
    carrierToken,
    options.fetch ?? globalThis.fetch,
    options.timeoutMs ?? 5_000,
  );
  const wireRequired = wireURL !== undefined || carrierToken !== undefined;
  const authRequired = carrierToken !== undefined;
  const healthy =
    runtime.status === "ok" &&
    hubReplay.status === "ok" &&
    (!wireRequired || carrier.wire.status === "ok") &&
    (!authRequired || carrier.carrierAuth.status === "ok");
  return {
    schema: HUB_SUPERVISOR_DOCTOR_SCHEMA,
    configured: true,
    healthy,
    protocolPin: ORGANUM_CODE_SIGNED_HUB_PIN,
    checks: {
      wire: carrier.wire,
      carrierAuth: carrier.carrierAuth,
      hubReplay,
      runtime,
    },
  };
}

export function formatHubSupervisorDoctor(
  report: HubSupervisorDoctorReport,
): string[] {
  if (!report.configured) return ["Signed Hub: unconfigured"];
  return [
    `Signed Hub: ${report.healthy ? "ok" : "FAIL"} (pin ${report.protocolPin})`,
    `Signed Hub runtime: ${report.checks.runtime.status} — ${report.checks.runtime.detail}`,
    `Signed Hub replay: ${report.checks.hubReplay.status} — ${report.checks.hubReplay.detail}`,
    `Signed Hub wire: ${report.checks.wire.status} — ${report.checks.wire.detail}`,
    `Signed Hub carrier auth: ${report.checks.carrierAuth.status} — ${report.checks.carrierAuth.detail}`,
  ];
}
