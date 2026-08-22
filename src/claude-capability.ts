export const CLAUDE_CODE_CAPABILITY_SCHEMA =
  "organum-code/claude-code-capability/v1";

export interface ClaudeCodeCapabilityObservation {
  observedAt: string;
  binary: string;
  binaryVersion: string;
  loopbackProviderRequests: number;
  messagesProtocolObserved: boolean;
  toolUseRequested: boolean;
  toolResultObserved: boolean;
  apiCredentialVisibleToTool: boolean;
  streamJsonObserved: boolean;
  deterministicSessionID: boolean;
  interruptSent: boolean;
  interruptExited: boolean;
  providerRequestCancelled: boolean;
  failureKind: string | null;
}

export interface ClaudeCodeCapabilityReport {
  schema: typeof CLAUDE_CODE_CAPABILITY_SCHEMA;
  observed_at: string;
  gate: "pass" | "fail";
  binary: {
    command: string;
    version: string;
  };
  transport: {
    provider_base_url: "loopback";
    loopback_provider_requests: number;
    real_model_calls: 0;
  };
  capabilities: {
    anthropic_messages: boolean;
    controlled_tool_round_trip: boolean;
    stream_json: boolean;
    deterministic_session_id: boolean;
    interrupt: {
      process_exited: boolean;
      provider_request_cancelled: boolean;
    };
  };
  containment: {
    api_credential_visible_to_tool: boolean;
    credential_broker_required: boolean;
  };
  failure_kind: string | null;
}

export function buildClaudeCodeCapabilityReport(
  observation: ClaudeCodeCapabilityObservation,
): ClaudeCodeCapabilityReport {
  const controlledToolRoundTrip =
    observation.toolUseRequested && observation.toolResultObserved;
  const interrupted =
    observation.interruptSent &&
    observation.interruptExited &&
    observation.providerRequestCancelled;
  const credentialBrokerRequired = observation.apiCredentialVisibleToTool;
  const gate =
    observation.failureKind === null &&
    observation.binaryVersion.length > 0 &&
    observation.messagesProtocolObserved &&
    controlledToolRoundTrip &&
    observation.streamJsonObserved &&
    observation.deterministicSessionID &&
    interrupted &&
    !credentialBrokerRequired;

  return {
    schema: CLAUDE_CODE_CAPABILITY_SCHEMA,
    observed_at: observation.observedAt,
    gate: gate ? "pass" : "fail",
    binary: {
      command: observation.binary,
      version: observation.binaryVersion,
    },
    transport: {
      provider_base_url: "loopback",
      loopback_provider_requests: observation.loopbackProviderRequests,
      real_model_calls: 0,
    },
    capabilities: {
      anthropic_messages: observation.messagesProtocolObserved,
      controlled_tool_round_trip: controlledToolRoundTrip,
      stream_json: observation.streamJsonObserved,
      deterministic_session_id: observation.deterministicSessionID,
      interrupt: {
        process_exited: observation.interruptSent && observation.interruptExited,
        provider_request_cancelled: interrupted,
      },
    },
    containment: {
      api_credential_visible_to_tool: observation.apiCredentialVisibleToTool,
      credential_broker_required: credentialBrokerRequired,
    },
    failure_kind: observation.failureKind,
  };
}
