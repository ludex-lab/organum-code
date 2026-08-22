import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { buildCoordinationSystemPacket } from "./coordination-context.js";
import {
  SessionCoordinationBootstrapper,
  type OrganumJoinClient,
  type SessionCoordinationState,
} from "./coordination-bootstrap.js";
import { OpenCodeRootSessionResolver } from "./opencode-session.js";
import {
  OrganumCli,
  ORGANUM_BENCH_OOB_LOG_ENV,
  ORGANUM_BENCH_ORIGIN_ENV,
  ORGANUM_BENCH_SEED_BODY_FILE_ENV,
  ORGANUM_BENCH_SEED_SENDER_ENV,
  ORGANUM_BENCH_SEED_THREAD_ENV,
  ORGANUM_BENCH_SEED_TOPIC_ENV,
} from "./organum-cli.js";
import { isValidCellIdentity } from "./organum-identity.js";
import {
  FileHubAdmissionLedger,
  type HubAdmissionLedger,
} from "./hub-admission-ledger.js";
import {
  SessionCoordinationPoller,
  type OrganumPollingClient,
} from "./coordination-polling.js";
import {
  SessionPublicationStateMachine,
  type PublicationClient,
} from "./coordination-publish.js";
import {
  loadProjectEnvironment,
  type ProjectEnvironmentPacket,
} from "./project-contract.js";
import {
  FIRST_PARTY_PLUGIN_PROTOCOL,
  ORGANUM_CODE_HUB_DIRECTORY_ENV,
  ORGANUM_CODE_INTENT_ENV,
  ORGANUM_CODE_ORGANUM_BIN_ENV,
  ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV,
  ORGANUM_CODE_PERSONA_ENV,
  ORGANUM_CODE_ROLE_ENV,
  ORGANUM_CODE_STATE_DIRECTORY_ENV,
  ORGANUM_CODE_WORKSPACE_ENV,
  PLUGIN_PROBE_ENV,
} from "./plugin-protocol.js";
import {
  initialOpenCodeCastDelivery,
  openCodeCastReceipt,
  updateOpenCodeCastDelivery,
  validateOpenCodeCastReceiptPath,
  writeOpenCodeCastReceipt,
} from "./opencode-cast-receipt.js";

const ROLES = new Set(["implementer", "reviewer", "critic", "researcher"]);

export interface OpenCodePluginInput {
  client: {
    app: {
      log(request: unknown): Promise<unknown>;
    };
    session: {
      get(request: {
        path: { id: string };
        query: { directory: string };
      }): Promise<{ data?: unknown; error?: unknown }>;
      promptAsync(request: {
        path: { id: string };
        query: { directory: string };
        body: {
          tools: Record<string, boolean>;
          parts: Array<{ type: "text"; text: string }>;
        };
      }): Promise<{ data?: unknown; error?: unknown }>;
    };
  };
  directory: string;
  worktree: string;
}

interface PluginDependencies {
  environment?: NodeJS.ProcessEnv;
  organum?: OrganumJoinClient & OrganumPollingClient & PublicationClient;
  project?: ProjectEnvironmentPacket;
  hubLedger?: HubAdmissionLedger;
  writeMarker?: (path: string, content: string) => Promise<void>;
}

export interface PluginHooks {
  tool: Record<string, PluginToolDefinition>;
  "chat.params": (
    input: { sessionID: string; agent: string; model: unknown },
    output: {
      maxOutputTokens: number | undefined;
      temperature?: number;
      topP?: number;
      topK?: number;
      options?: Record<string, unknown>;
    },
  ) => Promise<void>;
  event: (input: { event: OpenCodeEvent }) => Promise<void>;
  "shell.env": (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>;
  "experimental.chat.system.transform": (
    input: { sessionID?: string; model: unknown },
    output: { system: string[] },
  ) => Promise<void>;
  "experimental.text.complete": (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>;
  "tool.execute.before": (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
  "tool.execute.after": (
    input: {
      tool: string;
      sessionID: string;
      callID: string;
      args: unknown;
    },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>;
}

interface OpenCodeEvent {
  type: string;
  properties?: { sessionID?: unknown };
}

interface PluginToolContext {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
}

interface PluginToolDefinition {
  description: string;
  args: z.ZodRawShape;
  execute(
    args: Record<string, unknown>,
    context: PluginToolContext,
  ): Promise<string>;
}

interface RootToolEvidence {
  files: string[];
  reproduction: { command: string; summary: string } | null;
}

const PUBLICATION_ARGS = {
  body: z
    .string()
    .min(1)
    .max(32 * 1024)
    .optional()
    .describe(
      "Exact team-facing result, evidence, and unresolved risks. Omit only to publish the longest bounded assistant report already emitted in this root session.",
    ),
  to: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Optional relay recipient; omit to publish to Agora"),
  topic: z.string().max(128).optional(),
  thread: z.string().max(256).optional(),
  reply_to: z.string().max(256).optional(),
  display_from: z.string().max(256).optional(),
  escalate: z.boolean().optional(),
} satisfies z.ZodRawShape;

const PUBLICATION_INPUT = z.object(PUBLICATION_ARGS);
type PublicationToolInput = z.infer<typeof PUBLICATION_INPUT>;

const CLOSE_OUT_REMINDER =
  "[Organum Code close-out] Your substantive result is not durably shipped. Call organum_handoff exactly once with the team-facing result, concrete evidence, and unresolved risks. If a previous attempt failed, retry the exact same body and routing fields so the idempotency key converges. Do not repeat the analysis and do not use raw Organum CLI.";
const ENFORCED_CLOSE_OUT =
  "[Organum Code enforced close-out] The declared reproduction command succeeded. The investigation is now bounded: use at most eight read-only evidence lookups, then call organum_handoff. No other tool can run until the durable handoff closes this root session.";
const REVIEW_TURN_MAX_OUTPUT_TOKENS = 2_048;
const CLOSE_OUT_READ_BUDGET = 8;
const CLOSE_OUT_READ_TOOLS = new Set(["read", "glob", "grep"]);

const RAW_ORGANUM_COMMAND =
  /(?:^|[;&|()\n`])\s*(?:(?:env|command|exec|sudo)\s+)*(?:["']?[^\s;&|()]+\/)?["']?organum["']?(?=\s|$|[;&|()\n`])/;
const ORGANUM_LOOKUP_SUBSTITUTION =
  /\$\(\s*(?:command\s+-v|which)\s+organum\s*\)/;
const COORDINATION_STREAM_COMMAND =
  /(?:\.organum[\\/](?:agora|relay|hub)(?:[\\/\s"'|;&)]|$)|(?:\.local[\\/]state[\\/]organum-code|hub-admissions-v1)(?:[\\/\s"'|;&)]|$)|\b(?:ORGANUM_(?:CODE_(?:HUB|STATE)_DIR|HUB)|XDG_STATE_HOME)\b)/;

function rawOrganumCommand(args: unknown): boolean {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return false;
  }
  const command = (args as Record<string, unknown>).command;
  return (
    typeof command === "string" &&
    (RAW_ORGANUM_COMMAND.test(command) ||
      ORGANUM_LOOKUP_SUBSTITUTION.test(command))
  );
}

function record(args: unknown): Record<string, unknown> | null {
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

async function coordinationStreamPath(
  value: unknown,
  directory: string,
  hubDirectory?: string,
  stateDirectory?: string,
): Promise<boolean> {
  if (typeof value !== "string" || value.length === 0) return false;
  const candidate = isAbsolute(value) ? resolve(value) : resolve(directory, value);
  const roots = [
    resolve(directory, ".organum", "agora"),
    resolve(directory, ".organum", "relay"),
    ...(hubDirectory === undefined ? [] : [resolve(hubDirectory)]),
    ...(stateDirectory === undefined ? [] : [resolve(stateDirectory)]),
  ];
  if (roots.some((root) => inside(root, candidate))) return true;
  try {
    const canonicalCandidate = await realpath(candidate);
    for (const root of roots) {
      try {
        if (inside(await realpath(root), canonicalCandidate)) return true;
      } catch {
        // A missing stream root cannot be the target of a successful read.
      }
    }
  } catch {
    // Lexical checks above still protect missing or not-yet-created paths.
  }
  return false;
}

async function rawCoordinationStreamAccess(
  tool: string,
  args: unknown,
  directory: string,
  hubDirectory?: string,
  stateDirectory?: string,
): Promise<boolean> {
  const values = record(args);
  if (values === null) return false;
  if (tool === "bash") {
    return (
      typeof values.command === "string" &&
      (COORDINATION_STREAM_COMMAND.test(values.command) ||
        (hubDirectory !== undefined && values.command.includes(hubDirectory)) ||
        (stateDirectory !== undefined &&
          values.command.includes(stateDirectory)))
    );
  }
  if (tool === "read" || tool === "edit" || tool === "write") {
    return await coordinationStreamPath(
      values.filePath,
      directory,
      hubDirectory,
      stateDirectory,
    );
  }
  if (tool === "glob" || tool === "grep") {
    if (
      await coordinationStreamPath(
        values.path,
        directory,
        hubDirectory,
        stateDirectory,
      )
    ) {
      return true;
    }
    return (
      typeof values.pattern === "string" &&
      COORDINATION_STREAM_COMMAND.test(values.pattern)
    );
  }
  return false;
}

function readRole(environment: NodeJS.ProcessEnv): string {
  const role = environment[ORGANUM_CODE_ROLE_ENV]?.trim() || "implementer";
  if (!ROLES.has(role)) {
    throw new Error(`Invalid ${ORGANUM_CODE_ROLE_ENV} for first-party plugin`);
  }
  return role;
}

function readIntent(environment: NodeJS.ProcessEnv, role: string): string {
  const intent =
    environment[ORGANUM_CODE_INTENT_ENV]?.trim() || `${role} OpenCode session`;
  if (intent.includes("\0") || Buffer.byteLength(intent, "utf8") > 512) {
    throw new Error(`${ORGANUM_CODE_INTENT_ENV} must be at most 512 UTF-8 bytes`);
  }
  return intent;
}

function readHubDeclaration(environment: NodeJS.ProcessEnv): {
  persona?: string;
  workspace?: string;
} {
  const persona = environment[ORGANUM_CODE_PERSONA_ENV]?.trim();
  const workspace = environment[ORGANUM_CODE_WORKSPACE_ENV]?.trim();
  if ((persona === undefined) !== (workspace === undefined)) {
    throw new Error(
      `${ORGANUM_CODE_PERSONA_ENV} and ${ORGANUM_CODE_WORKSPACE_ENV} must be set together`,
    );
  }
  if (persona === undefined || workspace === undefined) return {};
  if (!isValidCellIdentity(persona) || !isValidCellIdentity(workspace)) {
    throw new Error(
      `${ORGANUM_CODE_PERSONA_ENV} and ${ORGANUM_CODE_WORKSPACE_ENV} must use the canonical Organum identity grammar`,
    );
  }
  return { persona: persona.toLowerCase(), workspace: workspace.toLowerCase() };
}

function readHubDirectory(environment: NodeJS.ProcessEnv): string | undefined {
  const raw = environment[ORGANUM_CODE_HUB_DIRECTORY_ENV];
  if (raw === undefined) return undefined;
  const hubDirectory = raw.trim();
  if (
    hubDirectory.length === 0 ||
    hubDirectory.includes("\0") ||
    !isAbsolute(hubDirectory)
  ) {
    throw new Error(
      `${ORGANUM_CODE_HUB_DIRECTORY_ENV} must be a nonempty absolute path`,
    );
  }
  return resolve(hubDirectory);
}

function readStateDirectory(
  environment: NodeJS.ProcessEnv,
  required: boolean,
): string | undefined {
  const raw = environment[ORGANUM_CODE_STATE_DIRECTORY_ENV];
  if (raw !== undefined) {
    const stateDirectory = raw.trim();
    if (
      stateDirectory.length === 0 ||
      stateDirectory.includes("\0") ||
      !isAbsolute(stateDirectory)
    ) {
      throw new Error(
        `${ORGANUM_CODE_STATE_DIRECTORY_ENV} must be a nonempty absolute path`,
      );
    }
    return resolve(stateDirectory);
  }
  if (!required) return undefined;
  const stateHome = environment.XDG_STATE_HOME?.trim();
  if (
    stateHome === undefined ||
    stateHome.length === 0 ||
    stateHome.includes("\0") ||
    !isAbsolute(stateHome)
  ) {
    throw new Error(
      `${ORGANUM_CODE_STATE_DIRECTORY_ENV} or an absolute XDG_STATE_HOME is required for hub admission durability`,
    );
  }
  return join(resolve(stateHome), "organum-code");
}

function defaultPublicationTopic(role: string): string {
  if (role === "reviewer" || role === "critic") return "review";
  if (role === "researcher") return "research";
  return "handoff";
}

function successfulToolExit(metadata: unknown): boolean {
  const value = record(metadata);
  return value?.exit === 0;
}

function declaredCommandPrefix(command: string, env: Record<string, string>): string {
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  return [...assignments, command].join(" ");
}

function startsWithShellCommand(candidate: string, expected: string): boolean {
  return candidate === expected || candidate.startsWith(`${expected} `);
}

function shellCommandSegments(candidate: string): string[] {
  return candidate
    .split(/\s*&&\s*/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function isSuccessfulDeclaredCommand(
  tool: string,
  args: unknown,
  metadata: unknown,
  project: ProjectEnvironmentPacket,
): boolean {
  if (tool !== "bash" || !successfulToolExit(metadata)) return false;
  const command = record(args)?.command;
  if (typeof command !== "string") return false;
  const candidates = shellCommandSegments(command.trim());
  return project.commands.some((entry) => {
    const expected = declaredCommandPrefix(entry.command, entry.env);
    return candidates.some(
      (candidate) =>
        startsWithShellCommand(candidate, expected) ||
        startsWithShellCommand(candidate, `env ${expected}`),
    );
  });
}

function groundedAssistantReport(text: string): boolean {
  return (
    /(?:src|tests)\/[A-Za-z0-9_./-]+:\d+/.test(text) &&
    /(?:pytest|passed|reproduc|재현|테스트|test)/i.test(text)
  );
}

function evidencePath(args: unknown, directory: string): string | null {
  const value = record(args)?.filePath;
  if (typeof value !== "string" || value.length === 0) return null;
  const candidate = isAbsolute(value) ? resolve(value) : resolve(directory, value);
  if (!inside(resolve(directory), candidate)) return null;
  const path = relative(resolve(directory), candidate);
  if (path.length === 0) return null;
  return path.split(sep).join("/");
}

function boundedCommandSummary(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const summary = [...lines]
    .reverse()
    .find((line) => /(?:passed|failed|error|test)/i.test(line));
  return Array.from(summary ?? "declared command completed with exit 0")
    .slice(0, 256)
    .join("");
}

function evidenceOnlyBody(evidence: RootToolEvidence | undefined): string | null {
  if (evidence?.reproduction === null || evidence?.reproduction === undefined) {
    return null;
  }
  if (evidence.files.length === 0) return null;
  const files = evidence.files
    .slice(0, 16)
    .map((path) => `- \`${path}:1\` (inspected)`)
    .join("\n");
  return [
    "## Harness-grounded critic handoff",
    "",
    "The critic explicitly requested `organum_handoff` without supplying a body. This evidence-only recovery publishes observable work and makes no unverified defect claim.",
    "",
    `Reproduction: \`${evidence.reproduction.command}\` completed with exit 0. ${evidence.reproduction.summary}`,
    "",
    "Inspected evidence:",
    files,
    "",
    "Result: the declared check passed; this fallback asserts no release-blocking defect beyond the evidence above.",
    "Limitation: no grounded ordinary-text narrative was supplied, so model reasoning was not exposed or treated as a finding.",
  ].join("\n");
}

async function diagnosticLog(
  input: OpenCodePluginInput,
  level: "debug" | "error",
  message: string,
): Promise<void> {
  try {
    await input.client.app.log({
      body: {
        service: "organum-code",
        level,
        message,
        extra: { protocol: FIRST_PARTY_PLUGIN_PROTOCOL },
      },
    });
  } catch {
    // Logging is diagnostic only and must not alter coordination semantics.
  }
}

export async function createOrganumCodePlugin(
  input: OpenCodePluginInput,
  dependencies: PluginDependencies = {},
): Promise<PluginHooks> {
  const environment = dependencies.environment ?? process.env;
  const role = readRole(environment);
  const intent = readIntent(environment, role);
  const hub = readHubDeclaration(environment);
  const hubDirectory = readHubDirectory(environment);
  const stateDirectory = readStateDirectory(
    environment,
    hub.persona !== undefined && dependencies.hubLedger === undefined,
  );
  const rawCastReceiptPath =
    environment[ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV]?.trim();
  const castReceiptPath = rawCastReceiptPath === undefined
    ? undefined
    : await validateOpenCodeCastReceiptPath(
        rawCastReceiptPath,
        input.directory,
      );
  if (
    stateDirectory !== undefined &&
    (inside(resolve(input.directory), stateDirectory) ||
      inside(stateDirectory, resolve(input.directory)))
  ) {
    throw new Error(
      `${ORGANUM_CODE_STATE_DIRECTORY_ENV} must be disjoint from the project directory`,
    );
  }
  if (
    stateDirectory !== undefined &&
    hubDirectory !== undefined &&
    (inside(hubDirectory, stateDirectory) ||
      inside(stateDirectory, hubDirectory))
  ) {
    throw new Error(
      `${ORGANUM_CODE_STATE_DIRECTORY_ENV} must be disjoint from ${ORGANUM_CODE_HUB_DIRECTORY_ENV}`,
    );
  }
  let hubLedger: HubAdmissionLedger | undefined;
  if (hub.persona !== undefined) {
    if (dependencies.hubLedger !== undefined) {
      hubLedger = dependencies.hubLedger;
    } else {
      if (stateDirectory === undefined) {
        throw new Error("Durable hub admission state directory is unavailable");
      }
      hubLedger = new FileHubAdmissionLedger(stateDirectory);
    }
  }
  const organum =
    dependencies.organum ??
    new OrganumCli({
      binary: environment[ORGANUM_CODE_ORGANUM_BIN_ENV]?.trim() || "organum",
      cwd: input.directory,
      env: environment,
      hubDirectory,
    });
  const roots = new OpenCodeRootSessionResolver(async (request) => {
    const response = await input.client.session.get({
      path: { id: request.sessionID },
      query: { directory: request.directory },
    });
    if (response.error !== undefined || response.data === undefined) {
      throw new Error("OpenCode session lookup returned no session data");
    }
    const data = response.data as { id?: unknown; parentID?: unknown };
    return {
      id: data.id as string,
      ...(data.parentID === undefined
        ? {}
        : { parentID: data.parentID as string }),
    };
  });
  const bootstrap = new SessionCoordinationBootstrapper(roots, organum);
  const poller = new SessionCoordinationPoller(
    organum,
    () => new Date(),
    hubLedger,
  );
  const publication = new SessionPublicationStateMachine(organum);
  const delivery = initialOpenCodeCastDelivery();
  const stagedDelivery = new Map<string, { relay: number }>();
  let receiptRoot: string | null = null;
  let receiptWrite = Promise.resolve();
  const persistCastReceipt = async (
    state: SessionCoordinationState,
  ): Promise<void> => {
    if (castReceiptPath === undefined) return;
    if (receiptRoot !== null && receiptRoot !== state.rootSessionID) {
      throw new Error("OpenCode cast receipt observed more than one root session");
    }
    receiptRoot = state.rootSessionID;
    const receipt = openCodeCastReceipt(
      state.rootSessionID,
      state.identity,
      delivery,
      publication.snapshot(state, input.directory),
    );
    receiptWrite = receiptWrite.then(async () => {
      await writeOpenCodeCastReceipt(castReceiptPath, receipt);
    });
    await receiptWrite;
  };
  const closeOutGates = new Map<string, { remainingReads: number }>();
  const shippedRoots = new Set<string>();
  const publicationBodies = new Map<
    string,
    { messageID: string; text: string }
  >();
  const toolEvidence = new Map<string, RootToolEvidence>();
  const project =
    dependencies.project ??
    (await loadProjectEnvironment(input.directory, environment));

  await diagnosticLog(input, "debug", "first-party plugin loaded");
  const marker = environment[PLUGIN_PROBE_ENV];
  if (marker) {
    const writeMarker =
      dependencies.writeMarker ??
      (async (path: string, content: string) => {
        await writeFile(path, content, "utf8");
      });
    await writeMarker(
      marker,
      `${JSON.stringify({
        plugin: "organum-code",
        protocol: FIRST_PARTY_PLUGIN_PROTOCOL,
      })}\n`,
    );
  }

  const ensureState = async (sessionID: string, signal?: AbortSignal) =>
    await bootstrap.ensure({
      sessionID,
      directory: input.directory,
      role,
      intent,
      persona: hub.persona,
      workspace: hub.workspace,
      signal,
    });

  const admitStagedDelivery = async (
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<SessionCoordinationState | undefined> => {
    const staged = stagedDelivery.get(sessionID);
    if (staged === undefined) return undefined;

    const state = await ensureState(sessionID, signal);
    if (stagedDelivery.get(sessionID) !== staged) return state;

    stagedDelivery.delete(sessionID);
    try {
      const admitted = await poller.admit(sessionID, input.directory, signal);
      delivery.admitted_turns += 1;
      delivery.admitted_items += admitted;
      delivery.relay_acks += staged.relay;
      await persistCastReceipt(state);
      return state;
    } catch (error) {
      if (!stagedDelivery.has(sessionID)) {
        stagedDelivery.set(sessionID, staged);
      }
      throw error;
    }
  };

  const executePublication = async (
    rawArgs: Record<string, unknown>,
    context: PluginToolContext,
    handoff: boolean,
  ): Promise<string> => {
    const args = PUBLICATION_INPUT.parse(rawArgs) as PublicationToolInput;
    const state = await ensureState(context.sessionID, context.abort);
    const observed = publicationBodies.get(state.rootSessionID);
    const observedBody =
      observed !== undefined && groundedAssistantReport(observed.text)
        ? observed.text
        : undefined;
    const body =
      args.body ?? observedBody ?? evidenceOnlyBody(toolEvidence.get(state.rootSessionID));
    if (body == null) {
      throw new Error(
        "organum_handoff requires body, a grounded assistant report, or sufficient observable reproduction evidence in this root session.",
      );
    }
    const result = await publication.publish(state, input.directory, {
      messageID: args.body === undefined && observed !== undefined
        ? observed.messageID
        : context.messageID,
      body,
      to: args.to,
      topic: args.topic ?? defaultPublicationTopic(role),
      thread: args.thread,
      replyTo: args.reply_to,
      displayFrom: args.display_from,
      escalate: args.escalate,
      handoff,
      signal: context.abort,
    });
    if (handoff) {
      closeOutGates.delete(state.rootSessionID);
      publicationBodies.delete(state.rootSessionID);
      toolEvidence.delete(state.rootSessionID);
      shippedRoots.add(state.rootSessionID);
    }
    await persistCastReceipt(state);
    context.metadata({
      title: handoff ? `Shipped ${result.file}` : `Published ${result.file}`,
      metadata: {
        phase: result.phase,
        file: result.file,
        from_id: result.from_id,
      },
    });
    return JSON.stringify(
      handoff
        ? {
            ...result,
            terminal: true,
            instruction:
              "Durable handoff is complete. Stop using tools and return only a brief final confirmation.",
          }
        : result,
      null,
      2,
    );
  };

  return {
    tool: {
      organum_publish: {
        description:
          "Publish a bounded team-facing contribution through the typed Organum adapter. This creates durable receipt evidence but does not end the session. On retry, use the exact same body and routing fields.",
        args: PUBLICATION_ARGS,
        execute: async (args, context) =>
          await executePublication(args, context, false),
      },
      organum_handoff: {
        description:
          "Terminal close-out: publish the exact result first, verify its durable receipt, then check the open session and end it with --ship. Use this before going idle after substantive work.",
        args: PUBLICATION_ARGS,
        execute: async (args, context) =>
          await executePublication(args, context, true),
      },
    },
    "chat.params": async (_hookInput, output) => {
      if (role !== "reviewer" && role !== "critic") return;
      output.maxOutputTokens = Math.min(
        output.maxOutputTokens ?? REVIEW_TURN_MAX_OUTPUT_TOKENS,
        REVIEW_TURN_MAX_OUTPUT_TOKENS,
      );
    },
    event: async ({ event }) => {
      if (
        event.type !== "session.idle" ||
        typeof event.properties?.sessionID !== "string"
      ) {
        return;
      }
      const sessionID = event.properties.sessionID;
      const action = await publication.handleIdle(
        sessionID,
        input.directory,
        async () => {
          const response = await input.client.session.promptAsync({
            path: { id: sessionID },
            query: { directory: input.directory },
            body: {
              tools: { organum_publish: true, organum_handoff: true },
              parts: [{ type: "text", text: CLOSE_OUT_REMINDER }],
            },
          });
          if (response.error !== undefined) {
            throw new Error("OpenCode rejected the publication close-out reminder");
          }
        },
      );
      if (action !== "ignored") {
        await diagnosticLog(input, "debug", `publication idle action: ${action}`);
      }
      await persistCastReceipt(await ensureState(sessionID));
    },
    "shell.env": async (_hookInput, output) => {
      output.env[ORGANUM_CODE_HUB_DIRECTORY_ENV] = "";
      output.env[ORGANUM_CODE_STATE_DIRECTORY_ENV] = "";
      output.env[ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV] = "";
      output.env[ORGANUM_BENCH_OOB_LOG_ENV] = "";
      output.env[ORGANUM_BENCH_ORIGIN_ENV] = "";
      output.env[ORGANUM_BENCH_SEED_BODY_FILE_ENV] = "";
      output.env[ORGANUM_BENCH_SEED_SENDER_ENV] = "";
      output.env[ORGANUM_BENCH_SEED_TOPIC_ENV] = "";
      output.env[ORGANUM_BENCH_SEED_THREAD_ENV] = "";
      output.env.XDG_STATE_HOME = join(
        environment.OPENCODE_CONFIG_DIR ?? environment.HOME ?? input.directory,
        "shell-state",
      );
      const home = environment.ORGANUM_CODE_HOST_HOME;
      const userProfile = environment.ORGANUM_CODE_HOST_USERPROFILE;
      const appData = environment.ORGANUM_CODE_HOST_APPDATA;
      const localAppData = environment.ORGANUM_CODE_HOST_LOCALAPPDATA;

      if (home) output.env.HOME = home;
      if (userProfile) output.env.USERPROFILE = userProfile;
      if (appData) output.env.APPDATA = appData;
      if (localAppData) output.env.LOCALAPPDATA = localAppData;
    },
    "experimental.chat.system.transform": async (hookInput, output) => {
      if (hookInput.sessionID === undefined) return;
      try {
        const bootstrapState = await ensureState(hookInput.sessionID);
        const state = await poller.poll(bootstrapState, input.directory);
        const packet = buildCoordinationSystemPacket(
          state,
          project,
          publication.snapshot(state, input.directory),
        );
        poller.stage(
          hookInput.sessionID,
          input.directory,
          state,
          packet.messageIDs,
        );
        stagedDelivery.set(hookInput.sessionID, {
          relay: packet.messageIDs.filter((id) => id.startsWith("relay:")).length,
        });
        updateOpenCodeCastDelivery(delivery, {
          turnID: hookInput.sessionID,
          packetSha256: createHash("sha256")
            .update(packet.text, "utf8")
            .digest("hex"),
          pollingStatus: state.polling.status,
          exposedItems: packet.messageIDs.length,
        });
        await persistCastReceipt(bootstrapState);
        output.system.push(packet.text);
        if (closeOutGates.has(bootstrapState.rootSessionID)) {
          output.system.push(ENFORCED_CLOSE_OUT);
        }
      } catch (error) {
        await diagnosticLog(input, "error", "coordination bootstrap failed");
        throw error;
      }
    },
    "experimental.text.complete": async (hookInput, output) => {
      const state = await ensureState(hookInput.sessionID);
      await publication.observeOutput(
        state,
        input.directory,
        hookInput.messageID,
        output.text,
      );
      const text = output.text.trim();
      const previous = publicationBodies.get(state.rootSessionID);
      if (text.length > 0 && (previous === undefined || text.length > previous.text.length)) {
        publicationBodies.set(state.rootSessionID, {
          messageID: hookInput.messageID,
          text,
        });
      }
      if (text.length > 0) {
        await admitStagedDelivery(hookInput.sessionID);
      }
      await persistCastReceipt(state);
    },
    "tool.execute.before": async (hookInput, output) => {
      const admittedState = await admitStagedDelivery(hookInput.sessionID);
      if (hookInput.tool === "bash" && rawOrganumCommand(output.args)) {
        throw new Error(
          "Raw Organum CLI access is disabled; use the bounded Organum Code coordination surface.",
        );
      }
      if (
        await rawCoordinationStreamAccess(
          hookInput.tool,
          output.args,
          input.directory,
          hubDirectory,
          stateDirectory,
        )
      ) {
        throw new Error(
          "Raw coordination Agora/relay/hub/actor-state storage access is disabled; use the injected bounded coordination context and typed publication tools.",
        );
      }
      if (role !== "reviewer" && role !== "critic") return;
      const state = admittedState ?? await ensureState(hookInput.sessionID);
      if (shippedRoots.has(state.rootSessionID)) {
        throw new Error(
          "This root session is already durably shipped. Stop using tools and return only a brief final confirmation.",
        );
      }
      const gate = closeOutGates.get(state.rootSessionID);
      if (gate === undefined || hookInput.tool === "organum_handoff") return;
      if (CLOSE_OUT_READ_TOOLS.has(hookInput.tool) && gate.remainingReads > 0) {
        gate.remainingReads -= 1;
        return;
      }
      throw new Error(
        "The declared reproduction already succeeded. Only organum_handoff is allowed now; publish the grounded result and close the session.",
      );
    },
    "tool.execute.after": async (hookInput, output) => {
      if (role !== "reviewer" && role !== "critic") return;
      const state = await ensureState(hookInput.sessionID);
      const evidence = toolEvidence.get(state.rootSessionID) ?? {
        files: [],
        reproduction: null,
      };
      if (hookInput.tool === "read") {
        const path = evidencePath(hookInput.args, input.directory);
        if (path !== null && !evidence.files.includes(path)) {
          evidence.files.push(path);
          toolEvidence.set(state.rootSessionID, evidence);
        }
      }
      if (
        !isSuccessfulDeclaredCommand(
          hookInput.tool,
          hookInput.args,
          output.metadata,
          project,
        )
      ) {
        return;
      }
      const command = record(hookInput.args)?.command;
      evidence.reproduction = {
        command: typeof command === "string" ? command.trim() : "declared command",
        summary: boundedCommandSummary(output.output),
      };
      toolEvidence.set(state.rootSessionID, evidence);
      if (!closeOutGates.has(state.rootSessionID)) {
        closeOutGates.set(state.rootSessionID, {
          remainingReads: CLOSE_OUT_READ_BUDGET,
        });
      }
    },
  };
}
