import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  ORGANUM_PUBLICATION_INPUT_SCHEMA,
  parseAcpPublicationArguments,
  type AcpPublicationArguments,
} from "./acp-coordination.js";
import type { AllocatedActorRuntime } from "./actor-runtime.js";
import {
  classifyStickyGoal,
  type SessionCoordinationState,
} from "./coordination-bootstrap.js";
import {
  FileCoordinationContinuityStore,
  type CoordinationContinuityBinding,
} from "./coordination-continuity.js";
import {
  buildCoordinationContextDocument,
  buildCoordinationSystemPacket,
  type CoordinationSystemPacket,
} from "./coordination-context.js";
import {
  SessionCoordinationPoller,
  type OrganumPollingClient,
  type PollingStatus,
} from "./coordination-polling.js";
import {
  CoordinationPublishError,
  PUBLICATION_PROTOCOL,
  SessionPublicationStateMachine,
  type PublicationClient,
  type PublicationEvidence,
  type PublicationSnapshot,
} from "./coordination-publish.js";
import {
  nativeInteractiveRootSessionID,
  type NativeInteractiveBackend,
} from "./native-interactive-lifecycle.js";
import {
  BoundedOrganumMcpEndpoint,
  type BoundedMcpTool,
} from "./organum-mcp.js";
import {
  deriveNativeCellIdentity,
  isValidCellIdentity,
  type CellIdentity,
} from "./organum-identity.js";
import { FileHubAdmissionLedger } from "./hub-admission-ledger.js";
import {
  OrganumCli,
  type JoinResult,
  type OrganumJoinRequest,
} from "./organum-cli.js";
import {
  ORGANUM_CODE_HUB_DIRECTORY_ENV,
  ORGANUM_CODE_INTENT_ENV,
  ORGANUM_CODE_ORGANUM_BIN_ENV,
  ORGANUM_CODE_PERSONA_ENV,
  ORGANUM_CODE_WORKSPACE_ENV,
} from "./plugin-protocol.js";
import {
  ConfigurationError,
  type ProviderProfile,
} from "./provider-profile.js";

const MAX_INTENT_BYTES = 512;
const MAX_BINARY_BYTES = 1_024;

export interface NativeProductCoordinationClient
  extends PublicationClient, OrganumPollingClient {
  join(request: OrganumJoinRequest): Promise<JoinResult>;
}

export interface NativeProductLifecycleDependencies {
  organum?: NativeProductCoordinationClient;
  now?: () => Date;
  mcpToken?: string;
}

export interface CreateNativeProductLifecycleOptions {
  actorRuntime: AllocatedActorRuntime;
  profile: ProviderProfile;
  environment?: NodeJS.ProcessEnv;
  directory?: string;
  upstreamApiKey?: string;
  dependencies?: NativeProductLifecycleDependencies;
}

export interface NativeProductLifecycle {
  backend: NativeInteractiveBackend;
  rootSessionID: string;
  identity: CellIdentity;
  joined: boolean;
  restoredRevision: number | null;
  state: SessionCoordinationState | null;
  endpoint: BoundedOrganumMcpEndpoint;
  snapshot(): PublicationSnapshot;
  prepareCoordinationTurn(turnID: string): Promise<NativeCoordinationTurn>;
  admitCoordinationTurn(turnID: string): Promise<number>;
  discardCoordinationTurn(turnID: string): void;
  coordinationSnapshot(): NativeCoordinationDeliverySnapshot;
  callPublication(
    arguments_: Record<string, unknown>,
    handoff: boolean,
  ): Promise<PublicationEvidence>;
}

export interface NativeCoordinationTurn {
  turnID: string;
  packet: CoordinationSystemPacket;
  packetSha256: string;
  pollingStatus: PollingStatus;
  exposed: {
    total: number;
    relay: number;
    agora: number;
    hub: number;
  };
}

export interface NativeCoordinationDeliverySnapshot {
  schema: "organum-code/native-coordination-delivery/v1";
  polls: number;
  prepared_turns: number;
  admitted_turns: number;
  exposed_items: number;
  admitted_items: number;
  relay_acks: number;
  last_turn_id: string | null;
  last_packet_sha256: string | null;
  last_polling_status: PollingStatus | null;
}

interface CoordinationDeclaration {
  role: string;
  intent: string;
  persona?: string;
  workspace?: string;
  hubDirectory?: string;
  organumBinary: string;
}

function nativeBackend(
  backend: AllocatedActorRuntime["backend"],
): NativeInteractiveBackend {
  if (
    backend === "claude" ||
    backend === "grok" ||
    backend === "deepcode" ||
    backend === "codex" ||
    backend === "cursor"
  ) {
    return backend;
  }
  throw new ConfigurationError(
    "Native product coordination requires Claude Code, Grok Build, Deep Code, Codex, or Cursor",
  );
}

function canonicalHubDimension(value: string, variable: string): string {
  if (!isValidCellIdentity(value)) {
    throw new ConfigurationError(
      `${variable} must use the canonical Organum identity grammar`,
    );
  }
  return value.toLowerCase();
}

function declaration(
  profile: ProviderProfile,
  backend: NativeInteractiveBackend,
  environment: NodeJS.ProcessEnv,
): CoordinationDeclaration {
  const intent =
    environment[ORGANUM_CODE_INTENT_ENV]?.trim() ||
    `${profile.role} ${backend} native actor`;
  if (
    intent.includes("\0") ||
    Buffer.byteLength(intent, "utf8") > MAX_INTENT_BYTES
  ) {
    throw new ConfigurationError(
      `${ORGANUM_CODE_INTENT_ENV} must be at most ${MAX_INTENT_BYTES} UTF-8 bytes without NUL`,
    );
  }

  const rawPersona = environment[ORGANUM_CODE_PERSONA_ENV]?.trim();
  const rawWorkspace = environment[ORGANUM_CODE_WORKSPACE_ENV]?.trim();
  if ((rawPersona === undefined) !== (rawWorkspace === undefined)) {
    throw new ConfigurationError(
      `${ORGANUM_CODE_PERSONA_ENV} and ${ORGANUM_CODE_WORKSPACE_ENV} must be set together`,
    );
  }
  const persona =
    rawPersona === undefined
      ? undefined
      : canonicalHubDimension(rawPersona, ORGANUM_CODE_PERSONA_ENV);
  const workspace =
    rawWorkspace === undefined
      ? undefined
      : canonicalHubDimension(rawWorkspace, ORGANUM_CODE_WORKSPACE_ENV);

  const rawHubDirectory =
    environment[ORGANUM_CODE_HUB_DIRECTORY_ENV]?.trim();
  let hubDirectory: string | undefined;
  if (rawHubDirectory !== undefined) {
    if (
      rawHubDirectory.length === 0 ||
      rawHubDirectory.includes("\0") ||
      !isAbsolute(rawHubDirectory)
    ) {
      throw new ConfigurationError(
        `${ORGANUM_CODE_HUB_DIRECTORY_ENV} must be a nonempty absolute path`,
      );
    }
    hubDirectory = resolve(rawHubDirectory);
  }

  const organumBinary =
    environment[ORGANUM_CODE_ORGANUM_BIN_ENV]?.trim() || "organum";
  if (
    organumBinary.includes("\0") ||
    Buffer.byteLength(organumBinary, "utf8") > MAX_BINARY_BYTES
  ) {
    throw new ConfigurationError(
      `${ORGANUM_CODE_ORGANUM_BIN_ENV} must be a bounded executable name without NUL`,
    );
  }
  return {
    role: profile.role,
    intent,
    ...(persona === undefined ? {} : { persona }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(hubDirectory === undefined ? {} : { hubDirectory }),
    organumBinary,
  };
}

function stateFromJoin(
  rootSessionID: string,
  identity: CellIdentity,
  role: string,
  joined: JoinResult,
): SessionCoordinationState {
  const goal = classifyStickyGoal(joined.goal);
  const warnings =
    goal.status === "canonical"
      ? []
      : goal.status === "missing"
        ? ["No canonical current goal is available for this native actor."]
        : ["The current native actor goal is incomplete or ambiguous."];
  return {
    rootSessionID,
    lineage: [rootSessionID],
    identity,
    role,
    persona: joined.persona,
    workspaceKey: joined.workspace?.key ?? null,
    registrationEpoch: joined.registration?.epoch ?? null,
    phase: warnings.length === 0 ? "ready" : "degraded",
    attempts: 1,
    join: joined,
    goal,
    warnings,
  };
}

function defaultPublicationTopic(role: string): string {
  if (role === "reviewer" || role === "critic") return "review";
  if (role === "researcher") return "research";
  return "handoff";
}

function bodyDigest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function boundedTurnID(value: string): string {
  const turnID = value.trim();
  if (
    turnID.length === 0 ||
    turnID.includes("\0") ||
    Buffer.byteLength(turnID, "utf8") > 256
  ) {
    throw new CoordinationPublishError(
      "Native coordination turn ID must be nonempty and at most 256 UTF-8 bytes",
      "contract",
    );
  }
  return turnID;
}

function publicationEvidence(
  snapshot: PublicationSnapshot,
): PublicationEvidence {
  if (snapshot.turn_id === null || snapshot.receipt === null) {
    throw new CoordinationPublishError(
      "Durable publication evidence is unavailable",
      "state",
    );
  }
  return {
    protocol: PUBLICATION_PROTOCOL,
    phase: snapshot.phase,
    turn_id: snapshot.turn_id,
    channel: snapshot.receipt.channel,
    to: snapshot.receipt.to,
    file: snapshot.receipt.file,
    from_id: snapshot.receipt.from_id,
    idem_key: snapshot.receipt.idem_key,
    shipped: snapshot.phase === "shipped",
  };
}

function assertCheckpointReplay(
  snapshot: PublicationSnapshot,
  input: AcpPublicationArguments,
  topic: string,
): void {
  const receipt = snapshot.receipt;
  if (
    receipt === null ||
    receipt.body_bytes !== Buffer.byteLength(input.body, "utf8") ||
    receipt.body_sha256 !== bodyDigest(input.body) ||
    receipt.channel !== (input.to === undefined ? "agora" : "relay") ||
    receipt.to !== (input.to ?? null) ||
    receipt.topic !== topic
  ) {
    throw new CoordinationPublishError(
      "The restored publication obligation has different durable content or routing; retry the checkpoint-matching handoff or choose a fresh actor",
      "conflict",
    );
  }
}

function publicationTool(
  lifecycle: Pick<NativeProductLifecycle, "callPublication">,
  handoff: boolean,
): BoundedMcpTool {
  return {
    name: handoff ? "organum_handoff" : "organum_publish",
    description: handoff
      ? "Terminal close-out. Publish the exact team-facing result, verify its durable receipt, and close this native actor's Organum session with shipped evidence."
      : "Publish one bounded team-facing contribution through this native actor's stable Organum identity without closing the session.",
    inputSchema: { ...ORGANUM_PUBLICATION_INPUT_SCHEMA },
    call: async (arguments_) =>
      await lifecycle.callPublication(arguments_, handoff),
  };
}

export async function createNativeProductLifecycle(
  options: CreateNativeProductLifecycleOptions,
): Promise<NativeProductLifecycle> {
  const environment = options.environment ?? process.env;
  const directory = resolve(options.directory ?? process.cwd());
  const backend = nativeBackend(options.actorRuntime.backend);
  const declared = declaration(options.profile, backend, environment);
  const rootSessionID = nativeInteractiveRootSessionID(options.actorRuntime);
  const identity = deriveNativeCellIdentity(backend, rootSessionID);
  const binding: CoordinationContinuityBinding = {
    backend,
    workspaceFingerprint: options.actorRuntime.workspaceFingerprint,
    rootSessionID,
    role: declared.role,
  };
  const store = new FileCoordinationContinuityStore(
    options.actorRuntime.stateDirectory,
    options.dependencies?.now,
  );
  const restored = await store.load(binding);
  const organum =
    options.dependencies?.organum ??
    new OrganumCli({
      binary: declared.organumBinary,
      cwd: directory,
      env: environment,
      hubDirectory: declared.hubDirectory,
      redactions:
        options.upstreamApiKey === undefined
          ? []
          : [options.upstreamApiKey],
    });

  const restoredPublication = restored?.context.publication ?? null;
  const terminalRestored =
    restoredPublication?.phase === "shipped" ||
    restoredPublication?.phase === "nonconformant";
  let state: SessionCoordinationState | null = null;
  if (!terminalRestored) {
    const joined = await organum.join({
      identity,
      role: declared.role,
      intent: declared.intent,
      persona: declared.persona,
      workspace: declared.workspace,
    });
    state = stateFromJoin(rootSessionID, identity, declared.role, joined);
  }

  const machine = new SessionPublicationStateMachine(organum);
  const poller = new SessionCoordinationPoller(
    organum,
    options.dependencies?.now,
    new FileHubAdmissionLedger(options.actorRuntime.stateDirectory),
  );
  let activeTurn: NativeCoordinationTurn | null = null;
  let lastAdmittedTurn:
    | { turnID: string; admitted: number }
    | null = null;
  const delivery: NativeCoordinationDeliverySnapshot = {
    schema: "organum-code/native-coordination-delivery/v1",
    polls: 0,
    prepared_turns: 0,
    admitted_turns: 0,
    exposed_items: 0,
    admitted_items: 0,
    relay_acks: 0,
    last_turn_id: null,
    last_packet_sha256: null,
    last_polling_status: null,
  };
  let durableSnapshot: PublicationSnapshot =
    restoredPublication ?? {
      protocol: PUBLICATION_PROTOCOL,
      phase: "clean",
      turn_id: null,
      reminders: 0,
      receipt: null,
      last_error: null,
      note_error: null,
      terminal_required: true,
    };
  let hasRestoredReceipt = restoredPublication?.receipt !== null &&
    restoredPublication?.receipt !== undefined;
  let publicationSequence = restored?.revision ?? 0;

  const save = async (snapshot: PublicationSnapshot): Promise<void> => {
    if (state === null) return;
    const saved = await store.save(
      binding,
      buildCoordinationContextDocument(state, null, snapshot),
    );
    durableSnapshot = saved.context.publication ?? snapshot;
  };

  if (state !== null) {
    await save(durableSnapshot);
  }

  const implementation = {
    async prepareCoordinationTurn(
      rawTurnID: string,
    ): Promise<NativeCoordinationTurn> {
      const turnID = boundedTurnID(rawTurnID);
      if (state === null) {
        throw new CoordinationPublishError(
          "Native actor coordination state is unavailable",
          "state",
        );
      }
      if (activeTurn !== null) {
        if (activeTurn.turnID !== turnID) {
          throw new CoordinationPublishError(
            "A different native coordination turn is already active",
            "conflict",
          );
        }
        return structuredClone(activeTurn);
      }
      if (lastAdmittedTurn?.turnID === turnID) {
        throw new CoordinationPublishError(
          "The native coordination turn was already admitted",
          "conflict",
        );
      }
      const turnState = await poller.poll(state, directory);
      const packet = buildCoordinationSystemPacket(
        turnState,
        null,
        durableSnapshot,
      );
      poller.stage(turnID, directory, turnState, packet.messageIDs);
      const exposed = {
        total: packet.messageIDs.length,
        relay: packet.messageIDs.filter((id) => id.startsWith("relay:")).length,
        agora: packet.messageIDs.filter((id) => id.startsWith("agora:")).length,
        hub: packet.messageIDs.filter((id) => id.startsWith("home-hub:")).length,
      };
      activeTurn = {
        turnID,
        packet,
        packetSha256: bodyDigest(packet.text),
        pollingStatus: turnState.polling.status,
        exposed,
      };
      delivery.polls += 1;
      delivery.prepared_turns += 1;
      delivery.exposed_items += exposed.total;
      delivery.last_turn_id = turnID;
      delivery.last_packet_sha256 = activeTurn.packetSha256;
      delivery.last_polling_status = activeTurn.pollingStatus;
      return structuredClone(activeTurn);
    },
    async admitCoordinationTurn(rawTurnID: string): Promise<number> {
      const turnID = boundedTurnID(rawTurnID);
      if (activeTurn === null) {
        if (lastAdmittedTurn?.turnID === turnID) {
          return lastAdmittedTurn.admitted;
        }
        throw new CoordinationPublishError(
          "No matching native coordination turn is active",
          "state",
        );
      }
      if (activeTurn.turnID !== turnID) {
        throw new CoordinationPublishError(
          "Native coordination admission does not match the active turn",
          "conflict",
        );
      }
      const admitted = await poller.admit(turnID, directory);
      delivery.admitted_turns += 1;
      delivery.admitted_items += admitted;
      delivery.relay_acks += activeTurn.exposed.relay;
      lastAdmittedTurn = { turnID, admitted };
      activeTurn = null;
      return admitted;
    },
    discardCoordinationTurn(rawTurnID: string): void {
      const turnID = boundedTurnID(rawTurnID);
      if (activeTurn === null) return;
      if (activeTurn.turnID !== turnID) {
        throw new CoordinationPublishError(
          "Native coordination discard does not match the active turn",
          "conflict",
        );
      }
      poller.discard(turnID, directory);
      activeTurn = null;
    },
    async callPublication(
      arguments_: Record<string, unknown>,
      handoff: boolean,
    ): Promise<PublicationEvidence> {
      const input = parseAcpPublicationArguments(arguments_);
      const topic = input.topic ?? defaultPublicationTopic(declared.role);

      if (
        durableSnapshot.phase === "shipped" ||
        durableSnapshot.phase === "nonconformant"
      ) {
        if (durableSnapshot.phase === "nonconformant") {
          throw new CoordinationPublishError(
            "This restored actor root is terminally nonconformant; choose a fresh actor",
            "state",
          );
        }
        assertCheckpointReplay(durableSnapshot, input, topic);
        return publicationEvidence(durableSnapshot);
      }

      if (hasRestoredReceipt && durableSnapshot.receipt !== null) {
        assertCheckpointReplay(durableSnapshot, input, topic);
        if (!handoff) return publicationEvidence(durableSnapshot);
        const status = await organum.sessionStatus(identity);
        if (status !== null) {
          await organum.end(identity, durableSnapshot.receipt.file);
        }
        durableSnapshot = {
          ...durableSnapshot,
          phase: "shipped",
          last_error: null,
          note_error: null,
        };
        await save(durableSnapshot);
        hasRestoredReceipt = false;
        return publicationEvidence(durableSnapshot);
      }

      if (state === null) {
        throw new CoordinationPublishError(
          "Native actor coordination state is unavailable",
          "state",
        );
      }

      const current = machine.snapshot(state, directory);
      let messageID =
        durableSnapshot.turn_id ??
        `${rootSessionID}:native-publication:${publicationSequence + 1}`;
      if (
        current.phase === "published" &&
        !handoff
      ) {
        publicationSequence += 1;
        messageID =
          `${rootSessionID}:native-publication:${publicationSequence + 1}`;
      }
      await machine.beginTurn(state, directory, messageID);
      // Persist the supervisor-owned turn before the first external write.
      // A crash after Organum accepts the body can then retry with the same
      // identity+turn+body idempotency key instead of creating a second file.
      await save(machine.snapshot(state, directory));
      try {
        const result = await machine.publish(state, directory, {
          messageID,
          body: input.body,
          to: input.to,
          topic,
          thread: input.thread,
          replyTo: input.replyTo,
          displayFrom: input.displayFrom,
          escalate: input.escalate,
          handoff,
        });
        await save(machine.snapshot(state, directory));
        return result;
      } catch (error) {
        await save(machine.snapshot(state, directory)).catch(() => undefined);
        throw error;
      }
    },
  };
  const endpoint = new BoundedOrganumMcpEndpoint(
    [
      publicationTool(implementation, false),
      publicationTool(implementation, true),
    ],
    options.dependencies?.mcpToken,
  );
  return {
    backend,
    rootSessionID,
    identity,
    joined: state !== null,
    restoredRevision: restored?.revision ?? null,
    state,
    endpoint,
    snapshot: () => structuredClone(durableSnapshot),
    prepareCoordinationTurn: implementation.prepareCoordinationTurn,
    admitCoordinationTurn: implementation.admitCoordinationTurn,
    discardCoordinationTurn: implementation.discardCoordinationTurn,
    coordinationSnapshot: () => structuredClone(delivery),
    callPublication: implementation.callPublication,
  };
}
