import {
  NATIVE_TOOL_CAPABILITY_SCHEMA,
  deriveNativeToolCapabilityClass,
  nativeToolCapabilitySchema,
  type NativeToolCapability,
} from "./native-tool-approval.js";
import { TOOL_ARGUMENT_CANONICALIZATION } from "./tool-argument-canonicalization.js";

export const GROK_NATIVE_HOOK_EVIDENCE =
  "evals/grok-native-hook-fail-open-s13-2026-07-26.json" as const;
export const GROK_PREREGISTERED_WRAPPER_EVIDENCE =
  "evals/grok-preregistered-tool-wrapper-s13-2026-07-26.json" as const;
export const GROK_PRODUCTION_PROJECTION_EVIDENCE =
  "evals/grok-native-tool-production-projection-s13-2026-07-26.json" as const;
export const GROK_PREREGISTERED_WRAPPER_FIXTURE =
  "grok-preregistered-exact-wrapper-s13-v2" as const;
export const GROK_PREREGISTERED_WRAPPER_PRODUCT_SURFACE =
  "cli-print-wrapper-projection" as const;
export const GROK_PREREGISTERED_WRAPPER_I8_BOUND =
  "Standing native permission authorizes only an inactive argument-free wrapper transport; effect authority remains the one-shot supervisor grant." as const;
export const GROK_PREREGISTERED_WRAPPER_POLICY = {
  id: "organum-s13-preregistered-terminal",
  version: "1.1.0",
} as const;
export const GROK_S13_ADMISSION_RECEIPT =
  "receipt:grok-0.2.112+9bbd559437aa:macos-26.5.2-darwin-25.5.0:cli-print-wrapper-projection:full" as const;

export interface GrokPreregisteredWrapperCapabilityObservation {
  sourceRevision: string;
  backendVersion: string;
  platformVersion: string;
  preExec: boolean;
  rejectBlocks: boolean;
  exactOnce: boolean;
  cancelClose: boolean;
  secretFree: boolean;
  unknownClosed: boolean;
  noStandingGrant: boolean;
  settled: boolean;
  containmentFloor: boolean;
}

function evidence(fragment: string): string {
  return `${GROK_PREREGISTERED_WRAPPER_EVIDENCE}#${fragment}`;
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

function productionPass(fragment: string) {
  return {
    status: "pass" as const,
    reason: "verified" as const,
    evidence: `${GROK_PRODUCTION_PROJECTION_EVIDENCE}#${fragment}`,
  };
}

export function buildGrokPreregisteredWrapperCapability(
  observation: GrokPreregisteredWrapperCapabilityObservation,
): NativeToolCapability {
  const invariants = {
    I1_PRE_EXEC: measured(
      observation.preExec,
      "derived.validAllowExactlyOnce",
    ),
    I2_REQUEST_BINDING: productionPass(
      "derived.requestBinding",
    ),
    I3_REJECT_BLOCKS: measured(
      observation.rejectBlocks,
      "derived.allRejectedBlocked",
    ),
    I4_EXACT_ONCE: measured(
      observation.exactOnce,
      "derived.replayExactlyOnce",
    ),
    I5_CANCEL_CLOSE: measured(
      observation.cancelClose,
      "derived.cancelAndStaleBlocked",
    ),
    I6_SECRET_FREE: measured(
      observation.secretFree,
      "derived.brokerTokenScrubbed",
    ),
    I7_UNKNOWN_CLOSED: measured(
      observation.unknownClosed,
      "derived.unknownWriteBlocked",
    ),
    I8_NO_STANDING_GRANT: measured(
      observation.noStandingGrant,
      "derived.inactiveWrapperRequiresFreshGrant",
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
      backendId: "grok",
      backendVersion: observation.backendVersion,
      productSurface: GROK_PREREGISTERED_WRAPPER_PRODUCT_SURFACE,
      launchMode:
        "broker-preregistered-exact-wrapper-dontask-provider-zero",
      platform: "darwin",
      platformVersion: observation.platformVersion,
    },
    fixture: {
      id: GROK_PREREGISTERED_WRAPPER_FIXTURE,
      sourceRevision: observation.sourceRevision,
      providerCalls: 0,
      argumentCanonicalization: TOOL_ARGUMENT_CANONICALIZATION,
      policy: GROK_PREREGISTERED_WRAPPER_POLICY,
    },
    invariants,
    classification: deriveNativeToolCapabilityClass(invariants),
    receipt: GROK_S13_ADMISSION_RECEIPT,
  });
}
