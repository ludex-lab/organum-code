import { inspectClaudeCode } from "./claude-launcher.js";
import { inspectDeepCode } from "./deepcode-launcher.js";
import { inspectGrokBuild } from "./grok-launcher.js";
import type {
  InferenceBrokerSession,
  InferenceBrokerSnapshot,
} from "./inference-broker.js";
import type { NativeBenchmarkBackendID } from "./native-adapter-conformance.js";
import {
  createClaudeSoftwareBenchmarkDriver,
  createDeepCodeSoftwareBenchmarkDriver,
  createGrokSoftwareBenchmarkDriver,
  type NativeSoftwareBenchmarkBackendDriver,
} from "./native-benchmark-backend.js";
import type { ProviderProfile } from "./provider-profile.js";

export const NATIVE_CLAUDE_ADVERTISED_MODEL = "claude-sonnet-4-5";

export interface NativeAdapterInstallation {
  binary: string;
  version: string;
}

export function inspectNativeAdapter(
  backend: NativeBenchmarkBackendID,
  env: NodeJS.ProcessEnv,
): NativeAdapterInstallation {
  return backend === "claude"
    ? inspectClaudeCode(env)
    : backend === "grok"
      ? inspectGrokBuild(env)
      : inspectDeepCode(env);
}

export interface NativeAdapterFixtureDriverOptions {
  backend: NativeBenchmarkBackendID;
  profile: ProviderProfile;
  env: NodeJS.ProcessEnv;
  session: InferenceBrokerSession;
  usageSnapshot: () => InferenceBrokerSnapshot;
  diagnosticRedactions: readonly string[];
}

export function createNativeAdapterFixtureDriver(
  options: NativeAdapterFixtureDriverOptions,
): NativeSoftwareBenchmarkBackendDriver {
  return options.backend === "claude"
    ? createClaudeSoftwareBenchmarkDriver({
        profile: options.profile,
        env: options.env,
        session: options.session,
        advertisedModel: NATIVE_CLAUDE_ADVERTISED_MODEL,
        usageSnapshot: options.usageSnapshot,
        captureActorDiagnostic: true,
        diagnosticRedactions: options.diagnosticRedactions,
      })
    : options.backend === "grok"
      ? createGrokSoftwareBenchmarkDriver({
          profile: options.profile,
          env: options.env,
          usageSnapshot: options.usageSnapshot,
          captureActorDiagnostic: true,
          diagnosticRedactions: options.diagnosticRedactions,
        })
      : createDeepCodeSoftwareBenchmarkDriver({
          profile: options.profile,
          env: options.env,
          usageSnapshot: options.usageSnapshot,
          captureActorDiagnostic: true,
          diagnosticRedactions: options.diagnosticRedactions,
        });
}
