import {
  NATIVE_TOOL_CAPABILITY_SCHEMA,
  deriveNativeToolCapabilityClass,
  nativeToolCapabilitySchema,
  type NativeToolCapability,
} from "./native-tool-approval.js";
import { TOOL_ARGUMENT_CANONICALIZATION } from "./tool-argument-canonicalization.js";

export const CLAUDE_PRODUCTION_HOOK_EVIDENCE =
  "evals/claude-native-tool-production-projection-s14b-2026-07-28.json" as const;
export const CLAUDE_PRODUCTION_HOOK_FIXTURE =
  "claude-production-hook-projection-s14b-matrix" as const;
export const CLAUDE_PRODUCTION_HOOK_PRODUCT_SURFACE =
  "cli-print-hook-projection" as const;
export const CLAUDE_PRODUCTION_HOOK_POLICY = {
  id: "organum-s14-production-hook-projection",
  version: "1.0.0",
} as const;
export const CLAUDE_S14_ADMISSION_RECEIPT =
  "receipt:claude-2.1.220:macos-26.5.2-darwin-25.5.0:cli-print-hook-projection:full" as const;

export interface ClaudeProductionHookCapabilityObservation {
  sourceRevision: string;
  backendVersion: string;
  platformVersion: string;
  preExec: boolean;
  requestBinding: boolean;
  rejectBlocks: boolean;
  exactOnce: boolean;
  cancelClose: boolean;
  secretFree: boolean;
  unknownClosed: boolean;
  noStandingGrant: boolean;
  settled: boolean;
  containmentFloor: boolean;
}

function measured(value: boolean, fragment: string) {
  return {
    status: value ? "pass" as const : "fail" as const,
    reason: value ? "verified" as const : "counterexample" as const,
    evidence: `${CLAUDE_PRODUCTION_HOOK_EVIDENCE}#${fragment}`,
  };
}

export function buildClaudeProductionHookCapability(
  observation: ClaudeProductionHookCapabilityObservation,
): NativeToolCapability {
  const invariants = {
    I1_PRE_EXEC: measured(observation.preExec, "derived.I1PreExec"),
    I2_REQUEST_BINDING: measured(
      observation.requestBinding,
      "derived.I2RequestBinding",
    ),
    I3_REJECT_BLOCKS: measured(
      observation.rejectBlocks,
      "derived.I3RejectBlocks",
    ),
    I4_EXACT_ONCE: measured(observation.exactOnce, "derived.I4ExactOnce"),
    I5_CANCEL_CLOSE: measured(
      observation.cancelClose,
      "derived.I5CancelClose",
    ),
    I6_SECRET_FREE: measured(observation.secretFree, "derived.I6SecretFree"),
    I7_UNKNOWN_CLOSED: measured(
      observation.unknownClosed,
      "derived.I7UnknownClosed",
    ),
    I8_NO_STANDING_GRANT: measured(
      observation.noStandingGrant,
      "derived.I8NoStandingGrant",
    ),
    I9_SETTLED: measured(observation.settled, "derived.I9Settled"),
    I10_CONTAINMENT_FLOOR: measured(
      observation.containmentFloor,
      "derived.I10ContainmentFloor",
    ),
  };
  const classification = deriveNativeToolCapabilityClass(invariants);
  return nativeToolCapabilitySchema.parse({
    schema: NATIVE_TOOL_CAPABILITY_SCHEMA,
    path: {
      backendId: "claude",
      backendVersion: observation.backendVersion,
      productSurface: CLAUDE_PRODUCTION_HOOK_PRODUCT_SURFACE,
      launchMode:
        "broker-response-preregistered-pretooluse-dontask-provider-zero",
      platform: "darwin",
      platformVersion: observation.platformVersion,
    },
    fixture: {
      id: CLAUDE_PRODUCTION_HOOK_FIXTURE,
      sourceRevision: observation.sourceRevision,
      providerCalls: 0,
      argumentCanonicalization: TOOL_ARGUMENT_CANONICALIZATION,
      policy: CLAUDE_PRODUCTION_HOOK_POLICY,
    },
    invariants,
    classification,
    receipt:
      classification === "full" ? CLAUDE_S14_ADMISSION_RECEIPT : null,
  });
}
