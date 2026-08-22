export const OPENCODE_SESSION_CAPABILITY_SCHEMA =
  "organum-code/opencode-session-capability/v1";

export interface OpenCodeSessionCapabilityObservation {
  observedAt: string;
  binary: string;
  binaryVersion: string;
  healthVersion: string;
  sessionCreateStatus: number;
  deterministicSessionID: boolean;
  legacyConfiguredProvider: boolean;
  legacyConfiguredAgent: boolean;
  v2ConfiguredProvider: boolean;
  v2ConfiguredAgent: boolean;
  configuredModelExecution: boolean;
  queueAdmissionStatus: number;
  queueRetryStatus: number;
  queueRetrySameReceipt: boolean;
  queueConflictStatus: number;
  steerAdmissionStatus: number;
  queueAdmissionInHistory: boolean;
  steerAdmissionInHistory: boolean;
  queuePromotionInHistory: boolean;
  steerPromotionInHistory: boolean;
  idleInterruptStatus: number;
  activeInterruptStatus: number;
  activeObservedBeforeInterrupt: boolean;
  inactiveObservedAfterInterrupt: boolean;
  providerRequestCancelled: boolean;
  loopbackProviderRequests: number;
  failureKind: string | null;
}

export interface OpenCodeSessionCapabilityReport {
  schema: typeof OPENCODE_SESSION_CAPABILITY_SCHEMA;
  observed_at: string;
  gate: "pass" | "fail";
  binary: {
    command: string;
    version: string;
    health_version: string;
  };
  transport: {
    loopback_only: true;
    loopback_provider_requests: number;
    external_provider_calls: 0;
  };
  capabilities: {
    v2_session_create: boolean;
    deterministic_session_id: boolean;
    registry: {
      legacy_configured_provider: boolean;
      legacy_configured_agent: boolean;
      v2_configured_provider: boolean;
      v2_configured_agent: boolean;
      configured_model_execution: boolean;
    };
    prompt_admission: boolean;
    delivery: {
      queue: boolean;
      steer: boolean;
    };
    deterministic_message_id: {
      replay_same_receipt: boolean;
      payload_conflict: boolean;
    };
    durable_events: {
      queue_admission: boolean;
      steer_admission: boolean;
      queue_promotion: boolean;
      steer_promotion: boolean;
    };
    interrupt: {
      idle_noop: boolean;
      active_request: boolean;
      active_state_cleared: boolean;
      provider_request_cancelled: boolean;
    };
  };
  failure_kind: string | null;
}

export function buildOpenCodeSessionCapabilityReport(
  observation: OpenCodeSessionCapabilityObservation,
): OpenCodeSessionCapabilityReport {
  const sameVersion =
    observation.binaryVersion.length > 0 &&
    observation.binaryVersion === observation.healthVersion;
  const v2SessionCreate =
    sameVersion && observation.sessionCreateStatus === 200;
  const queueAdmission = observation.queueAdmissionStatus === 200;
  const steerAdmission = observation.steerAdmissionStatus === 200;
  const replaySameReceipt =
    observation.queueRetryStatus === 200 &&
    observation.queueRetrySameReceipt;
  const payloadConflict = observation.queueConflictStatus === 409;
  const idleNoop = observation.idleInterruptStatus === 204;
  const activeRequest =
    observation.activeInterruptStatus === 204 &&
    observation.activeObservedBeforeInterrupt;

  const capabilities = {
    v2_session_create: v2SessionCreate,
    deterministic_session_id:
      v2SessionCreate && observation.deterministicSessionID,
    registry: {
      legacy_configured_provider: observation.legacyConfiguredProvider,
      legacy_configured_agent: observation.legacyConfiguredAgent,
      v2_configured_provider: observation.v2ConfiguredProvider,
      v2_configured_agent: observation.v2ConfiguredAgent,
      configured_model_execution: observation.configuredModelExecution,
    },
    prompt_admission: queueAdmission && steerAdmission,
    delivery: {
      queue: queueAdmission,
      steer: steerAdmission,
    },
    deterministic_message_id: {
      replay_same_receipt: replaySameReceipt,
      payload_conflict: payloadConflict,
    },
    durable_events: {
      queue_admission: observation.queueAdmissionInHistory,
      steer_admission: observation.steerAdmissionInHistory,
      queue_promotion: observation.queuePromotionInHistory,
      steer_promotion: observation.steerPromotionInHistory,
    },
    interrupt: {
      idle_noop: idleNoop,
      active_request: activeRequest,
      active_state_cleared:
        activeRequest && observation.inactiveObservedAfterInterrupt,
      provider_request_cancelled:
        activeRequest && observation.providerRequestCancelled,
    },
  };
  const gate =
    observation.failureKind === null &&
    capabilities.v2_session_create &&
    capabilities.deterministic_session_id &&
    capabilities.registry.legacy_configured_provider &&
    capabilities.registry.legacy_configured_agent &&
    capabilities.registry.v2_configured_provider &&
    capabilities.registry.v2_configured_agent &&
    capabilities.registry.configured_model_execution &&
    capabilities.prompt_admission &&
    capabilities.delivery.queue &&
    capabilities.delivery.steer &&
    capabilities.deterministic_message_id.replay_same_receipt &&
    capabilities.deterministic_message_id.payload_conflict &&
    capabilities.durable_events.queue_admission &&
    capabilities.durable_events.steer_admission &&
    capabilities.durable_events.queue_promotion &&
    capabilities.durable_events.steer_promotion &&
    capabilities.interrupt.idle_noop &&
    capabilities.interrupt.active_request &&
    capabilities.interrupt.active_state_cleared &&
    capabilities.interrupt.provider_request_cancelled;

  return {
    schema: OPENCODE_SESSION_CAPABILITY_SCHEMA,
    observed_at: observation.observedAt,
    gate: gate ? "pass" : "fail",
    binary: {
      command: observation.binary,
      version: observation.binaryVersion,
      health_version: observation.healthVersion,
    },
    transport: {
      loopback_only: true,
      loopback_provider_requests: observation.loopbackProviderRequests,
      external_provider_calls: 0,
    },
    capabilities,
    failure_kind: observation.failureKind,
  };
}
