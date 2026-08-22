import {
  NATIVE_TOOL_CAPABILITY_SCHEMA,
  deriveNativeToolCapabilityClass,
  nativeToolCapabilitySchema,
  type NativeToolCapability,
} from "./native-tool-approval.js";
import { TOOL_ARGUMENT_CANONICALIZATION } from "./tool-argument-canonicalization.js";

export const CLAUDE_PREREGISTERED_TOOL_EVIDENCE =
  "evals/claude-preregistered-tool-shim-s12c-2026-07-26.json" as const;
export const CLAUDE_PREREGISTERED_TOOL_FIXTURE =
  "claude-preregistered-tool-shim-s12c-v1" as const;
export const CLAUDE_PREREGISTERED_TOOL_POLICY = {
  id: "organum-s12c-preregistered-bash",
  version: "1.0.0",
} as const;

export interface ClaudePreregisteredToolCapabilityObservation {
  sourceRevision: string;
  backendVersion: string;
  platformVersion: string;
  preExec: boolean;
  rejectBlocks: boolean;
  exactOnce: boolean;
  cancelClose: boolean;
  secretFree: boolean;
  noStandingGrant: boolean;
  settled: boolean;
  containmentFloor: boolean;
}

function evidence(fragment: string): string {
  return `${CLAUDE_PREREGISTERED_TOOL_EVIDENCE}#${fragment}`;
}

function measured(value: boolean, fragment: string) {
  return value
    ? {
        status: "pass" as const,
        reason: "verified" as const,
        evidence: evidence(fragment),
      }
    : {
        status: "fail" as const,
        reason: "counterexample" as const,
        evidence: evidence(fragment),
      };
}

function unproven(fragment: string) {
  return {
    status: "unproven" as const,
    reason: "not_observed" as const,
    evidence: evidence(fragment),
  };
}

export function buildClaudePreregisteredToolCapability(
  observation: ClaudePreregisteredToolCapabilityObservation,
): NativeToolCapability {
  const invariants = {
    I1_PRE_EXEC: measured(
      observation.preExec,
      "derived.validAllowExactlyOnce",
    ),
    I2_REQUEST_BINDING: unproven("limitations.I2_REQUEST_BINDING"),
    I3_REJECT_BLOCKS: measured(
      observation.rejectBlocks,
      "derived.allDeniedScenariosBlocked",
    ),
    I4_EXACT_ONCE: measured(
      observation.exactOnce,
      "derived.replayExactOnce",
    ),
    I5_CANCEL_CLOSE: measured(
      observation.cancelClose,
      "derived.cancelAndStaleBlocked",
    ),
    I6_SECRET_FREE: measured(
      observation.secretFree,
      "fixture.durableProjectionSecretFree",
    ),
    I7_UNKNOWN_CLOSED: unproven("limitations.I7_UNKNOWN_CLOSED"),
    I8_NO_STANDING_GRANT: measured(
      observation.noStandingGrant,
      "derived.replayExactOnce",
    ),
    I9_SETTLED: measured(observation.settled, "derived.settled"),
    I10_CONTAINMENT_FLOOR: measured(
      observation.containmentFloor,
      "derived.outerContainmentBlockedApprovedEffect",
    ),
  };
  return nativeToolCapabilitySchema.parse({
    schema: NATIVE_TOOL_CAPABILITY_SCHEMA,
    path: {
      backendId: "claude",
      backendVersion: observation.backendVersion,
      productSurface: "cli-print",
      launchMode:
        "broker-preregistered-command-hook-dontask-loopback-provider-zero",
      platform: "darwin",
      platformVersion: observation.platformVersion,
    },
    fixture: {
      id: CLAUDE_PREREGISTERED_TOOL_FIXTURE,
      sourceRevision: observation.sourceRevision,
      providerCalls: 0,
      argumentCanonicalization: TOOL_ARGUMENT_CANONICALIZATION,
      policy: CLAUDE_PREREGISTERED_TOOL_POLICY,
    },
    invariants,
    classification: deriveNativeToolCapabilityClass(invariants),
    receipt: null,
  });
}
