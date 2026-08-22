import { z } from "zod";

import {
  NATIVE_TOOL_CAPABILITY_SCHEMA,
  deriveNativeToolCapabilityClass,
  nativeToolCapabilitySchema,
  type NativeToolCapability,
  type NativeToolInvariantStatus,
} from "./native-tool-approval.js";
import { TOOL_ARGUMENT_CANONICALIZATION } from "./tool-argument-canonicalization.js";

export const CLAUDE_NATIVE_TOOL_PROBE_SCHEMA =
  "organum-code/claude-native-tool-capability-probe/v1" as const;
export const CLAUDE_NATIVE_TOOL_PROBE_FIXTURE =
  "claude-pretooluse-provider-zero-v1" as const;
export const CLAUDE_NATIVE_TOOL_PROBE_POLICY = {
  id: "organum-s12-probe",
  version: "1.0.0",
} as const;
export const CLAUDE_NATIVE_TOOL_PROBE_EVIDENCE =
  "evals/claude-native-tool-capability-s12b-2026-07-26.json" as const;

const sha1Schema = z.string().regex(/^[0-9a-f]{40}$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const platformVersionSchema = z
  .string()
  .regex(/^macos-\d+(?:\.\d+){1,2}-darwin-\d+(?:\.\d+){1,3}$/);

export interface ClaudeNativeToolProbeObservation {
  observedAt: string;
  sourceRevision: string;
  binary: string;
  backendVersion: string;
  platformVersion: string;
  externalProviderCalls: 0;
  loopbackSimulatorRequests: number;
  loopbackHookRequests: number;
  processRuns: number;
  processFailures: number;
  hookRequestShapeValid: boolean;
  hookObservedBeforeEffect: boolean;
  rejectHookObserved: boolean;
  rejectEffectCount: number;
  rejectResultObserved: boolean;
  allowHookObserved: boolean;
  allowEffectCount: number;
  secondHookObserved: boolean;
  secondRejectEffectCount: number;
  secondRejectResultObserved: boolean;
  isolatedSettings: boolean;
  durableProjectionSecretFree: boolean;
  outerContainmentPrepared: boolean;
  containmentAllowHookObserved: boolean;
  containmentEffectCount: number;
  containmentFailureResultObserved: boolean;
  failureKind: string | null;
}

export interface ClaudeNativeToolProbeReport {
  schema: typeof CLAUDE_NATIVE_TOOL_PROBE_SCHEMA;
  observed_at: string;
  probe: "pass" | "fail";
  binary: {
    command: string;
    version: string;
  };
  transport: {
    external_provider_calls: 0;
    loopback_provider_simulator_requests: number;
    loopback_hook_requests: number;
  };
  observations: {
    real_native_process_runs: number;
    real_native_process_failures: number;
    hook_request_shape_valid: boolean;
    hook_observed_before_effect: boolean;
    reject_hook_observed: boolean;
    reject_effect_count: number;
    reject_result_observed: boolean;
    allow_hook_observed: boolean;
    allow_effect_count: number;
    second_hook_observed: boolean;
    second_reject_effect_count: number;
    second_reject_result_observed: boolean;
    isolated_settings: boolean;
    durable_projection_secret_free: boolean;
    outer_containment_prepared: boolean;
    containment_allow_hook_observed: boolean;
    containment_effect_count: number;
    containment_failure_result_observed: boolean;
  };
  limitations: {
    I2_REQUEST_BINDING: string;
    I4_EXACT_ONCE: string;
    I5_CANCEL_CLOSE: string;
    I7_UNKNOWN_CLOSED: string;
    I9_SETTLED: string;
  };
  capability: NativeToolCapability;
  failure_kind: string | null;
}

function evidence(fragment: string): string {
  return `${CLAUDE_NATIVE_TOOL_PROBE_EVIDENCE}#${fragment}`;
}

function invariant(
  status: NativeToolInvariantStatus,
  reason:
    | "verified"
    | "counterexample"
    | "fixture_failed"
    | "not_observed"
    | "surface_unavailable"
    | "version_drift"
    | "fixture_unavailable",
  fragment: string,
) {
  return { status, reason, evidence: evidence(fragment) } as const;
}

function observedPassOrFailure(
  observed: boolean,
  passed: boolean,
  fragment: string,
) {
  if (!observed) return invariant("unproven", "not_observed", fragment);
  return passed
    ? invariant("pass", "verified", fragment)
    : invariant("fail", "counterexample", fragment);
}

export function buildClaudeNativeToolProbeReport(
  observation: ClaudeNativeToolProbeObservation,
): ClaudeNativeToolProbeReport {
  const version = versionSchema.parse(observation.backendVersion);
  const platformVersion = platformVersionSchema.parse(
    observation.platformVersion,
  );
  const sourceRevision = sha1Schema.parse(observation.sourceRevision);

  const preExecObserved =
    observation.rejectHookObserved ||
    observation.allowHookObserved ||
    observation.containmentAllowHookObserved;
  const rejectObserved =
    observation.rejectHookObserved && observation.rejectResultObserved;
  const standingGrantObserved =
    observation.allowHookObserved &&
    observation.secondHookObserved &&
    observation.secondRejectResultObserved;
  const containmentObserved =
    observation.outerContainmentPrepared &&
    observation.containmentAllowHookObserved &&
    observation.containmentFailureResultObserved;

  const invariants = {
    I1_PRE_EXEC: observedPassOrFailure(
      preExecObserved,
      observation.hookRequestShapeValid &&
        observation.hookObservedBeforeEffect,
      "observations.hook_observed_before_effect",
    ),
    I2_REQUEST_BINDING: invariant(
      "unproven",
      "not_observed",
      "limitations.I2_REQUEST_BINDING",
    ),
    I3_REJECT_BLOCKS: observedPassOrFailure(
      rejectObserved,
      observation.rejectEffectCount === 0,
      "observations.reject_effect_count",
    ),
    I4_EXACT_ONCE: invariant(
      "unproven",
      "not_observed",
      "limitations.I4_EXACT_ONCE",
    ),
    I5_CANCEL_CLOSE: invariant(
      "unproven",
      "not_observed",
      "limitations.I5_CANCEL_CLOSE",
    ),
    I6_SECRET_FREE: observation.durableProjectionSecretFree
      ? invariant(
          "pass",
          "verified",
          "observations.durable_projection_secret_free",
        )
      : invariant(
          "fail",
          "counterexample",
          "observations.durable_projection_secret_free",
        ),
    I7_UNKNOWN_CLOSED: invariant(
      "unproven",
      "not_observed",
      "limitations.I7_UNKNOWN_CLOSED",
    ),
    I8_NO_STANDING_GRANT: observedPassOrFailure(
      standingGrantObserved,
      observation.isolatedSettings &&
        observation.allowEffectCount === 1 &&
        observation.secondRejectEffectCount === 1,
      "observations.second_reject_effect_count",
    ),
    I9_SETTLED: invariant(
      "unproven",
      "not_observed",
      "limitations.I9_SETTLED",
    ),
    I10_CONTAINMENT_FLOOR: observedPassOrFailure(
      containmentObserved,
      observation.containmentEffectCount === 0,
      "observations.containment_effect_count",
    ),
  };
  const classification = deriveNativeToolCapabilityClass(invariants);
  const capability = nativeToolCapabilitySchema.parse({
    schema: NATIVE_TOOL_CAPABILITY_SCHEMA,
    path: {
      backendId: "claude",
      backendVersion: version,
      productSurface: "cli-print",
      launchMode: "isolated-settings-pretooluse-http-loopback",
      platform: "darwin",
      platformVersion,
    },
    fixture: {
      id: CLAUDE_NATIVE_TOOL_PROBE_FIXTURE,
      sourceRevision,
      providerCalls: observation.externalProviderCalls,
      argumentCanonicalization: TOOL_ARGUMENT_CANONICALIZATION,
      policy: CLAUDE_NATIVE_TOOL_PROBE_POLICY,
    },
    invariants,
    classification,
    receipt: null,
  });

  const probePassed =
    observation.failureKind === null &&
    observation.processRuns === 3 &&
    observation.processFailures === 0 &&
    observation.loopbackSimulatorRequests >= 7 &&
    observation.loopbackHookRequests === 4 &&
    capability.invariants.I1_PRE_EXEC.status === "pass" &&
    capability.invariants.I3_REJECT_BLOCKS.status === "pass" &&
    capability.invariants.I6_SECRET_FREE.status === "pass" &&
    capability.invariants.I8_NO_STANDING_GRANT.status === "pass" &&
    capability.invariants.I10_CONTAINMENT_FLOOR.status === "pass" &&
    capability.classification === "partial";

  return {
    schema: CLAUDE_NATIVE_TOOL_PROBE_SCHEMA,
    observed_at: observation.observedAt,
    probe: probePassed ? "pass" : "fail",
    binary: {
      command: observation.binary,
      version,
    },
    transport: {
      external_provider_calls: observation.externalProviderCalls,
      loopback_provider_simulator_requests:
        observation.loopbackSimulatorRequests,
      loopback_hook_requests: observation.loopbackHookRequests,
    },
    observations: {
      real_native_process_runs: observation.processRuns,
      real_native_process_failures: observation.processFailures,
      hook_request_shape_valid: observation.hookRequestShapeValid,
      hook_observed_before_effect: observation.hookObservedBeforeEffect,
      reject_hook_observed: observation.rejectHookObserved,
      reject_effect_count: observation.rejectEffectCount,
      reject_result_observed: observation.rejectResultObserved,
      allow_hook_observed: observation.allowHookObserved,
      allow_effect_count: observation.allowEffectCount,
      second_hook_observed: observation.secondHookObserved,
      second_reject_effect_count: observation.secondRejectEffectCount,
      second_reject_result_observed:
        observation.secondRejectResultObserved,
      isolated_settings: observation.isolatedSettings,
      durable_projection_secret_free:
        observation.durableProjectionSecretFree,
      outer_containment_prepared: observation.outerContainmentPrepared,
      containment_allow_hook_observed:
        observation.containmentAllowHookObserved,
      containment_effect_count: observation.containmentEffectCount,
      containment_failure_result_observed:
        observation.containmentFailureResultObserved,
    },
    limitations: {
      I2_REQUEST_BINDING:
        "No supervisor actor/session/turn binding, replay, substitution, or concurrent-presenter fixture was run.",
      I4_EXACT_ONCE:
        "No supervisor-issued one-shot grant was atomically consumed at the native pre-effect seam.",
      I5_CANCEL_CLOSE:
        "No pending supervisor grant existed to revoke across turn, process, or session cancellation.",
      I7_UNKNOWN_CLOSED:
        "No production exact native-tool mapping or unknown-name policy adapter was attached.",
      I9_SETTLED:
        "No production decision/grant ledger existed for pending-zero settlement reconciliation.",
    },
    capability,
    failure_kind: probePassed
      ? null
      : observation.failureKind ?? "qualification_fixture_failed",
  };
}
