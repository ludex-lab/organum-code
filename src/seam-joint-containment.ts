import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstatSync,
  type Dirent,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  canonicalExistingPath,
  type ContainmentDependencies,
  ContainmentUnavailableError,
  prepareBackendContainment,
  type PreparedBackendContainment,
} from "./containment.js";
import {
  canonicalizeSJC1,
  type SJC1ActualApply,
  type SJC1JSONValue,
  type SJC1Lane,
  SJC1_LANES,
  type SJC1NegativeProbes,
  SJC1_PROBE_TARGETS,
  sha256Bytes,
  sha256SJC1,
} from "./seam-joint-receipt.js";

const SAFE_ENVIRONMENT_NAMES = [
  "LANG",
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
] as const;
const BLOCKED_FS_CODES = new Set(["EACCES", "EBADF", "EPERM"]);
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_TREE_FILES = 20_000;
const MAX_TREE_BYTES = 128 * 1024 * 1024;

export const SJC1_POLICY_SCHEMA =
  "organum-code/seam-joint-containment-policy/v1" as const;
export const SJC1_RAW_EVIDENCE_SCHEMA =
  "organum-code/seam-joint-raw-evidence/v1" as const;

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function intersects(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left);
}

function pathIdentity(path: string): string {
  return sha256Bytes(Buffer.from(path, "utf8"));
}

function assertCanonicalID(value: string, context: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new ContainmentUnavailableError(`${context} is not a canonical ID`);
  }
}

async function canonicalDirectory(path: string, context: string): Promise<string> {
  const canonical = canonicalExistingPath(path, context);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ContainmentUnavailableError(`${context} must be a real directory`);
  }
  return canonical;
}

async function canonicalFile(path: string, context: string): Promise<string> {
  const canonical = canonicalExistingPath(path, context);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new ContainmentUnavailableError(`${context} must be a real regular file`);
  }
  return canonical;
}

export function buildSeamActorEnvironment(
  env: NodeJS.ProcessEnv,
  input: {
    home: string;
    brokerOrigin: string;
    cell: string;
    lane: SJC1Lane;
    capability: string;
  },
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of SAFE_ENVIRONMENT_NAMES) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LC_") && value !== undefined) result[name] = value;
  }
  return {
    ...result,
    HOME: input.home,
    USERPROFILE: input.home,
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    ORGANUM_CODE_SJC1_BROKER_ORIGIN: input.brokerOrigin,
    ORGANUM_CODE_SJC1_CELL: input.cell,
    ORGANUM_CODE_SJC1_LANE: input.lane,
    ORGANUM_CODE_SJC1_CAPABILITY: input.capability,
  };
}

export interface SJC1Request {
  cell: string;
  lane: SJC1Lane;
  binary: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  capability: string;
  brokerOrigin: string;
  laneViewRoot: string;
  runtimeDirectory: string;
  runnerRoot: string;
  peerViewRoot: string;
  packRoot: string;
  repositoryGitRoot: string;
  parentApplyRoot: string;
}

export interface SJC1LanePolicy extends Record<string, SJC1JSONValue> {
  schema: typeof SJC1_POLICY_SCHEMA;
  platform: "darwin";
  cell: string;
  lane: SJC1Lane;
  broker_origin_sha256: string;
  capability_sha256: string;
  executable_path_sha256: string;
  lane_view_path_sha256: string;
  runtime_path_sha256: string;
  denied_path_sha256: string[];
  sandbox_runtime_config_sha256: string;
  readable_classes: string[];
  writable_classes: string[];
  coordinator_surface: string[];
  stdio: string[];
  non_stdio_inheritance: "closed";
}

export interface PreparedSeamActorContainment
  extends PreparedBackendContainment {
  lane: SJC1Lane;
  policy: SJC1LanePolicy;
  boundary: {
    laneViewRoot: string;
    runtimeDirectory: string;
    runnerRoot: string;
    peerViewRoot: string;
    packRoot: string;
    repositoryGitRoot: string;
    parentApplyRoot: string;
  };
}

/**
 * SJC1's strict adapter around the production backend containment gate. It has
 * no caller-supplied readable path escape hatch: only the lane view, private
 * runtime, resolved actor executable, system runtime, and exact broker origin
 * are admitted by the underlying policy.
 */
export async function prepareSeamActorContainment(
  request: SJC1Request,
  dependencies: ContainmentDependencies = {},
): Promise<PreparedSeamActorContainment> {
  assertCanonicalID(request.cell, "SJC1 cell");
  if (!SJC1_LANES.includes(request.lane)) {
    throw new ContainmentUnavailableError("SJC1 lane must be core or sqlite");
  }
  if (request.capability.length < 16 || request.capability.includes("\0")) {
    throw new ContainmentUnavailableError("SJC1 capability is unavailable");
  }

  const laneViewRoot = await canonicalDirectory(request.laneViewRoot, "SJC1 lane view");
  const runtimeDirectory = await canonicalDirectory(
    request.runtimeDirectory,
    "SJC1 lane runtime",
  );
  const dangerEntries = await Promise.all([
    canonicalDirectory(request.runnerRoot, "SJC1 runner root"),
    canonicalDirectory(request.peerViewRoot, "SJC1 peer view"),
    canonicalDirectory(request.packRoot, "SJC1 pack root"),
    canonicalDirectory(request.repositoryGitRoot, "SJC1 repository .git"),
    canonicalDirectory(request.parentApplyRoot, "SJC1 parent apply root"),
  ]);
  const dangerLabels = ["runner", "peer", "pack", "repository .git", "parent apply"];

  if (intersects(laneViewRoot, runtimeDirectory)) {
    throw new ContainmentUnavailableError(
      "SJC1 lane view and lane runtime must be disjoint",
    );
  }
  dangerEntries.forEach((danger, index) => {
    if (intersects(laneViewRoot, danger) || intersects(runtimeDirectory, danger)) {
      throw new ContainmentUnavailableError(
        `SJC1 ${dangerLabels[index]} path must be disjoint from lane view/runtime`,
      );
    }
  });

  const home = join(runtimeDirectory, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const environment = buildSeamActorEnvironment(request.env, {
    home,
    brokerOrigin: new URL(request.brokerOrigin).origin,
    cell: request.cell,
    lane: request.lane,
    capability: request.capability,
  });
  const prepared = await prepareBackendContainment(
    {
      binary: request.binary,
      args: request.args,
      env: environment,
      workspace: laneViewRoot,
      runtimeDirectory,
      brokerOrigin: request.brokerOrigin,
      immutablePaths: dangerEntries,
      allowPty: false,
    },
    dependencies,
  );

  try {
    const allowRead = prepared.gate.config.filesystem.allowRead ?? [];
    const allowWrite = prepared.gate.config.filesystem.allowWrite;
    for (const danger of dangerEntries) {
      if (
        allowRead.some((root) => intersects(root, danger)) ||
        allowWrite.some((root) => intersects(root, danger))
      ) {
        throw new ContainmentUnavailableError(
          "SJC1 dangerous path was admitted by the generated policy",
        );
      }
    }
    const policy: SJC1LanePolicy = {
      schema: SJC1_POLICY_SCHEMA,
      platform: "darwin",
      cell: request.cell,
      lane: request.lane,
      broker_origin_sha256: sha256Bytes(new URL(request.brokerOrigin).origin),
      capability_sha256: sha256Bytes(request.capability),
      executable_path_sha256: pathIdentity(prepared.binary),
      lane_view_path_sha256: pathIdentity(laneViewRoot),
      runtime_path_sha256: pathIdentity(runtimeDirectory),
      denied_path_sha256: dangerEntries.map(pathIdentity).sort(),
      sandbox_runtime_config_sha256: sha256SJC1(prepared.gate.config),
      readable_classes: [
        "actor-executable",
        "lane-runtime",
        "lane-view",
        "system-runtime",
      ],
      writable_classes: ["lane-runtime", "lane-view"],
      coordinator_surface: ["capability-publish", "capability-read"],
      stdio: ["stdin", "stdout", "stderr"],
      non_stdio_inheritance: "closed",
    };
    return {
      ...prepared,
      lane: request.lane,
      policy,
      boundary: {
        laneViewRoot,
        runtimeDirectory,
        runnerRoot: dangerEntries[0],
        peerViewRoot: dangerEntries[1],
        packRoot: dangerEntries[2],
        repositoryGitRoot: dangerEntries[3],
        parentApplyRoot: dangerEntries[4],
      },
    };
  } catch (error) {
    await prepared.gate.close().catch(() => undefined);
    throw error;
  }
}

export function combinedSJC1PolicySha256(
  prepared: Record<SJC1Lane, PreparedSeamActorContainment>,
  actualApplyPolicySha256: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(actualApplyPolicySha256)) {
    throw new ContainmentUnavailableError(
      "SJC1 actual-apply containment policy digest is unavailable",
    );
  }
  return sha256SJC1({
    schema: "organum-code/seam-joint-combined-containment-policy/v1",
    lanes: {
      core: prepared.core.policy,
      sqlite: prepared.sqlite.policy,
    },
    runner_actual_apply_policy_sha256: actualApplyPolicySha256,
  });
}

interface ExactSpawnResult {
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  } catch {
    // The exact child may already have exited.
  }
}

async function runExactSpawn(
  prepared: PreparedBackendContainment,
  stdin: string,
  timeoutMs: number,
): Promise<ExactSpawnResult> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(prepared.spawn.executable, prepared.spawn.args, {
      cwd: prepared.cwd,
      env: prepared.spawn.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    const append = (stream: "stdout" | "stderr", chunk: string): void => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_CAPTURE_BYTES) {
        killProcessTree(child.pid);
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: string) => append("stderr", chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (outputBytes > MAX_CAPTURE_BYTES) {
        rejectRun(new ContainmentUnavailableError("SJC1 child output exceeded its bound"));
        return;
      }
      resolveRun({ exitCode: code ?? 1, timedOut, stdout, stderr });
    });
    child.stdin.end(stdin, "utf8");
  });
}

const SJC1_PROBE_CHILD_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { readSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";

let stdin = "";
for await (const chunk of process.stdin) stdin += chunk;
const input = JSON.parse(stdin);
const observations = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fsAttempt = async (probe, op, target, action) => {
  let blocked = false;
  let error_code = null;
  try { await action(); }
  catch (error) {
    error_code = typeof error?.code === "string" ? error.code : error?.name ?? "Error";
    blocked = ["EACCES", "EBADF", "EPERM"].includes(error_code);
  }
  observations.push({ probe, op, target, attempted: true, blocked,
                      observation: { kind: "fs-error", error_code } });
};

const own = await readFile(input.own_view_file);
if (hash(own) !== input.own_view_sha256) throw new Error("own view read mismatch");
await writeFile(input.runtime_file, input.runtime_marker, { flag: "wx", mode: 0o600 });
if ((await readFile(input.runtime_file, "utf8")) !== input.runtime_marker) {
  throw new Error("lane runtime write mismatch");
}
const headers = {
  authorization: "Bearer " + process.env.ORGANUM_CODE_SJC1_CAPABILITY,
  "content-type": "application/json",
  "x-organum-cell": process.env.ORGANUM_CODE_SJC1_CELL,
  "x-organum-lane": process.env.ORGANUM_CODE_SJC1_LANE,
};
for (const path of ["/capability/publish", "/capability/read"]) {
  const response = await fetch(process.env.ORGANUM_CODE_SJC1_BROKER_ORIGIN + path, {
    method: path.endsWith("publish") ? "POST" : "GET",
    headers,
    body: path.endsWith("publish") ? JSON.stringify({ kind: "proposal", body: "sjc1" }) : undefined,
  });
  if (response.status !== 200) throw new Error("capability shim positive path failed");
  await response.arrayBuffer();
}

await fsAttempt("runner_board_rw", "read", "runner-board-relative",
                async () => { await readFile(input.runner_board_relative); });
await fsAttempt("runner_board_rw", "write", "runner-board-relative",
                async () => { await appendFile(input.runner_board_relative, "forbidden\\n"); });
await fsAttempt("peer_absolute_read", "read", "peer-view-absolute",
                async () => { await readFile(input.peer_absolute_file); });
await fsAttempt("pack_git_absolute_read", "pack", "pack-absolute",
                async () => { await readFile(input.pack_absolute_file); });
await fsAttempt("pack_git_absolute_read", "git", "repo-git-absolute",
                async () => { await readFile(input.git_absolute_file); });
await fsAttempt("inherited_fd_read", "read", "inherited-host-fd", async () => {
  const buffer = Buffer.alloc(1);
  readSync(input.inherited_host_fd, buffer, 0, 1, 0);
});
await fsAttempt("direct_board_write", "write", "runner-board-direct",
                async () => { await appendFile(input.runner_board_absolute, "forbidden\\n"); });

let controlStatus = null;
let controlBlocked = false;
try {
  const response = await fetch(
    process.env.ORGANUM_CODE_SJC1_BROKER_ORIGIN + "/runner/advance_turn",
    { method: "POST", headers },
  );
  controlStatus = response.status;
  controlBlocked = response.status === 403 || response.status === 404;
  await response.arrayBuffer();
} catch (error) {
  controlStatus = typeof error?.code === "string" ? error.code : error?.name ?? "Error";
}
observations.push({ probe: "actor_runner_control", op: "call",
                    target: "runner-control-api", attempted: true,
                    blocked: controlBlocked,
                    observation: { kind: "http-status", status: controlStatus } });
process.stdout.write(JSON.stringify({
  schema: "organum-code/seam-joint-probe-child/v1",
  lane: process.env.ORGANUM_CODE_SJC1_LANE,
  positive: { own_view_read: true, lane_runtime_write: true,
              capability_publish: true, capability_read: true },
  provider_calls: 0,
  observations,
}));
`;

export function sjc1ProbeCommand(): readonly string[] {
  return ["--input-type=module", "--eval", SJC1_PROBE_CHILD_SOURCE];
}

export interface SJC1ProbeTargets {
  ownViewFile: string;
  runtimeFile: string;
  runnerBoardRelative: string;
  runnerBoardAbsolute: string;
  peerAbsoluteFile: string;
  packAbsoluteFile: string;
  gitAbsoluteFile: string;
  inheritedHostFile: string;
}

export interface SJC1ProbeEvidence extends Record<string, SJC1JSONValue> {
  schema: typeof SJC1_RAW_EVIDENCE_SCHEMA;
  lane: SJC1Lane;
  probe: string;
  operation: string;
  target: string;
  attempted: true;
  blocked: true;
  target_identity_sha256: string;
  observation: Record<string, SJC1JSONValue>;
}

export interface SJC1LaneProbeResult {
  lane: SJC1Lane;
  policy: SJC1LanePolicy;
  negativeProbes: Record<string, Record<string, {
    attempted: true;
    blocked: true;
    target: string;
    evidence_sha256: string;
  }>>;
  rawEvidence: SJC1ProbeEvidence[];
  transcriptSha256: string;
  positive: Record<string, true>;
  providerCalls: 0;
}

interface ProbeChildObservation {
  probe: string;
  op: string;
  target: string;
  attempted: boolean;
  blocked: boolean;
  observation: Record<string, SJC1JSONValue>;
}

async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function runSJC1LaneProbe(
  prepared: PreparedSeamActorContainment,
  targets: SJC1ProbeTargets,
  timeoutMs = 15_000,
): Promise<SJC1LaneProbeResult> {
  const ownViewFile = await canonicalFile(targets.ownViewFile, "SJC1 own-view probe file");
  const runnerBoard = await canonicalFile(
    targets.runnerBoardAbsolute,
    "SJC1 runner board",
  );
  const peerFile = await canonicalFile(targets.peerAbsoluteFile, "SJC1 peer probe file");
  const packFile = await canonicalFile(targets.packAbsoluteFile, "SJC1 pack probe file");
  const gitFile = await canonicalFile(targets.gitAbsoluteFile, "SJC1 .git probe file");
  const inheritedFile = await canonicalFile(
    targets.inheritedHostFile,
    "SJC1 inherited host FD file",
  );
  const runtimeParent = await canonicalDirectory(
    resolve(targets.runtimeFile, ".."),
    "SJC1 runtime probe parent",
  );
  const runtimeFile = resolve(targets.runtimeFile);
  if (
    !inside(prepared.boundary.laneViewRoot, ownViewFile) ||
    !inside(prepared.boundary.runtimeDirectory, runtimeParent) ||
    !inside(prepared.boundary.runtimeDirectory, runtimeFile) ||
    !inside(prepared.boundary.runnerRoot, runnerBoard) ||
    !inside(prepared.boundary.peerViewRoot, peerFile) ||
    !inside(prepared.boundary.packRoot, packFile) ||
    !inside(prepared.boundary.repositoryGitRoot, gitFile) ||
    resolve(prepared.cwd, targets.runnerBoardRelative) !== runnerBoard ||
    intersects(prepared.boundary.laneViewRoot, inheritedFile) ||
    intersects(prepared.boundary.runtimeDirectory, inheritedFile)
  ) {
    throw new ContainmentUnavailableError(
      "SJC1 probe target does not bind its pinned authority class",
    );
  }
  if (await lstat(runtimeFile).then(() => true).catch(() => false)) {
    throw new ContainmentUnavailableError("SJC1 runtime positive target already exists");
  }

  const beforeBoard = await fileDigest(runnerBoard);
  const inheritedHandle = await open(inheritedFile, "r");
  const inheritedFD = inheritedHandle.fd;
  const runtimeMarker = `sjc1-${prepared.lane}-${sha256Bytes(inheritedFile).slice(0, 16)}`;
  let run: ExactSpawnResult;
  try {
    run = await runExactSpawn(
      prepared,
      JSON.stringify({
        own_view_file: ownViewFile,
        own_view_sha256: await fileDigest(ownViewFile),
        runtime_file: targets.runtimeFile,
        runtime_marker: runtimeMarker,
        runner_board_relative: targets.runnerBoardRelative,
        runner_board_absolute: runnerBoard,
        peer_absolute_file: peerFile,
        pack_absolute_file: packFile,
        git_absolute_file: gitFile,
        inherited_host_fd: inheritedFD,
      }),
      timeoutMs,
    );
  } finally {
    await inheritedHandle.close();
    await prepared.gate.close().catch(() => undefined);
  }
  if (run.timedOut || run.exitCode !== 0 || run.stderr.length > 0) {
    throw new ContainmentUnavailableError(
      `SJC1 ${prepared.lane} probe failed closed (exit=${run.exitCode}, timeout=${run.timedOut}, stderr_sha256=${sha256Bytes(run.stderr)})`,
    );
  }
  if ((await fileDigest(runnerBoard)) !== beforeBoard) {
    throw new ContainmentUnavailableError("SJC1 runner board changed during a blocked probe");
  }
  if ((await readFile(runtimeFile, "utf8")) !== runtimeMarker) {
    throw new ContainmentUnavailableError("SJC1 positive lane-runtime write is not grounded");
  }

  let transcript: {
    schema: string;
    lane: SJC1Lane;
    positive: Record<string, true>;
    provider_calls: number;
    observations: ProbeChildObservation[];
  };
  try {
    transcript = JSON.parse(run.stdout) as typeof transcript;
  } catch {
    throw new ContainmentUnavailableError("SJC1 probe child returned invalid JSON");
  }
  if (
    transcript.schema !== "organum-code/seam-joint-probe-child/v1" ||
    transcript.lane !== prepared.lane ||
    transcript.provider_calls !== 0 ||
    Object.keys(transcript.positive).sort().join(",") !==
      ["capability_publish", "capability_read", "lane_runtime_write", "own_view_read"]
        .sort()
        .join(",") ||
    Object.values(transcript.positive).some((value) => value !== true)
  ) {
    throw new ContainmentUnavailableError("SJC1 positive/provider-zero transcript is invalid");
  }

  const expected = Object.entries(SJC1_PROBE_TARGETS).flatMap(([probe, operations]) =>
    Object.entries(operations).map(([op, target]) => ({ probe, op, target })),
  );
  if (transcript.observations.length !== expected.length) {
    throw new ContainmentUnavailableError("SJC1 probe observation count is not exact");
  }
  const targetIdentities: Record<string, string> = {
    "runner_board_rw.read": pathIdentity(runnerBoard),
    "runner_board_rw.write": pathIdentity(runnerBoard),
    "peer_absolute_read.read": pathIdentity(peerFile),
    "pack_git_absolute_read.pack": pathIdentity(packFile),
    "pack_git_absolute_read.git": pathIdentity(gitFile),
    "inherited_fd_read.read": sha256SJC1({
      host_file_sha256: await fileDigest(inheritedFile),
      parent_fd: inheritedFD,
    }),
    "direct_board_write.write": pathIdentity(runnerBoard),
    "actor_runner_control.call": sha256SJC1({
      broker_origin_sha256: prepared.policy.broker_origin_sha256,
      endpoint: "/runner/advance_turn",
    }),
  };
  const negativeProbes: SJC1LaneProbeResult["negativeProbes"] = {};
  const rawEvidence: SJC1ProbeEvidence[] = [];
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index];
    const observed = transcript.observations[index];
    if (
      observed.probe !== wanted.probe ||
      observed.op !== wanted.op ||
      observed.target !== wanted.target ||
      observed.attempted !== true ||
      observed.blocked !== true
    ) {
      throw new ContainmentUnavailableError(
        `SJC1 ${prepared.lane}.${wanted.probe}.${wanted.op} was not an exact blocked attempt`,
      );
    }
    if (
      observed.observation.kind === "fs-error" &&
      !BLOCKED_FS_CODES.has(String(observed.observation.error_code))
    ) {
      throw new ContainmentUnavailableError(
        `SJC1 ${prepared.lane}.${wanted.probe}.${wanted.op} has no enforcing FS denial`,
      );
    }
    if (
      wanted.probe === "actor_runner_control" &&
      ![403, 404].includes(Number(observed.observation.status))
    ) {
      throw new ContainmentUnavailableError("SJC1 runner-control shim was not denied");
    }
    const evidence: SJC1ProbeEvidence = {
      schema: SJC1_RAW_EVIDENCE_SCHEMA,
      lane: prepared.lane,
      probe: wanted.probe,
      operation: wanted.op,
      target: wanted.target,
      attempted: true,
      blocked: true,
      target_identity_sha256: targetIdentities[`${wanted.probe}.${wanted.op}`],
      observation: observed.observation,
    };
    rawEvidence.push(evidence);
    negativeProbes[wanted.probe] ??= {};
    negativeProbes[wanted.probe][wanted.op] = {
      attempted: true,
      blocked: true,
      target: wanted.target,
      evidence_sha256: sha256SJC1(evidence),
    };
  }

  return {
    lane: prepared.lane,
    policy: prepared.policy,
    negativeProbes,
    rawEvidence,
    transcriptSha256: sha256SJC1(transcript),
    positive: transcript.positive,
    providerCalls: 0,
  };
}

export function combineSJC1ProbeResults(
  results: Record<SJC1Lane, SJC1LaneProbeResult>,
): {
  negativeProbes: SJC1NegativeProbes;
  transcriptSha256: string;
  providerCalls: 0;
} {
  if (results.core.providerCalls !== 0 || results.sqlite.providerCalls !== 0) {
    throw new ContainmentUnavailableError("SJC1 provider-zero conservation failed");
  }
  const negativeProbes = {
    core: results.core.negativeProbes,
    sqlite: results.sqlite.negativeProbes,
  } as SJC1NegativeProbes;
  return {
    negativeProbes,
    transcriptSha256: sha256SJC1({
      schema: "organum-code/seam-joint-turn-transcript/v1",
      lanes: {
        core: results.core.transcriptSha256,
        sqlite: results.sqlite.transcriptSha256,
      },
      provider_calls: 0,
    }),
    providerCalls: 0,
  };
}

interface TreeFile extends Record<string, SJC1JSONValue> {
  path: string;
  mode: number;
  bytes: number;
  sha256: string;
}

async function treeSha256(root: string): Promise<string> {
  const files: TreeFile[] = [];
  let totalBytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left: Dirent, right: Dirent) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (entry.name === ".git") {
        throw new ContainmentUnavailableError("SJC1 parent apply root must not contain .git");
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new ContainmentUnavailableError("SJC1 parent apply tree must not contain symlinks");
      }
      if (metadata.isDirectory()) {
        await walk(path);
        continue;
      }
      if (!metadata.isFile()) {
        throw new ContainmentUnavailableError("SJC1 parent apply tree has a special file");
      }
      totalBytes += metadata.size;
      if (files.length >= MAX_TREE_FILES || totalBytes > MAX_TREE_BYTES) {
        throw new ContainmentUnavailableError("SJC1 parent apply tree exceeds its bound");
      }
      const bytes = await readFile(path);
      files.push({
        path: relative(root, path).split(sep).join("/"),
        mode: metadata.mode & 0o777,
        bytes: bytes.byteLength,
        sha256: sha256Bytes(bytes),
      });
    }
  };
  await walk(root);
  return sha256SJC1({ schema: "organum-code/seam-parent-tree/v1", files });
}

export interface SJC1ActualApplyRequest {
  cell: string;
  parentApplyRoot: string;
  runtimeDirectory: string;
  brokerOrigin: string;
  env: NodeJS.ProcessEnv;
  gitBinary?: string;
  lanePatches: Record<SJC1Lane, Uint8Array>;
  mergePlanCommitment: Record<string, SJC1JSONValue>;
  immutablePaths: readonly string[];
  timeoutMs?: number;
}

export interface SJC1ActualApplyResult {
  actualApply: SJC1ActualApply;
  rawEvidence: Record<string, SJC1JSONValue>;
}

export async function runSJC1ActualApply(
  request: SJC1ActualApplyRequest,
  dependencies: ContainmentDependencies = {},
): Promise<SJC1ActualApplyResult> {
  assertCanonicalID(request.cell, "SJC1 actual-apply cell");
  const parentRoot = await canonicalDirectory(
    request.parentApplyRoot,
    "SJC1 parent apply root",
  );
  const runtime = await canonicalDirectory(
    request.runtimeDirectory,
    "SJC1 actual-apply runtime",
  );
  if (intersects(parentRoot, runtime)) {
    throw new ContainmentUnavailableError(
      "SJC1 parent apply root and runtime must be disjoint",
    );
  }
  for (const path of request.immutablePaths) {
    const canonical = canonicalExistingPath(path, "SJC1 actual-apply immutable path");
    if (intersects(parentRoot, canonical) || intersects(runtime, canonical)) {
      throw new ContainmentUnavailableError(
        "SJC1 actual-apply roots overlap an immutable seam path",
      );
    }
  }
  for (const lane of SJC1_LANES) {
    if (request.lanePatches[lane].byteLength > MAX_PATCH_BYTES) {
      throw new ContainmentUnavailableError(`SJC1 ${lane} patch exceeds its bound`);
    }
  }

  const patchSha = {
    core: sha256Bytes(request.lanePatches.core),
    sqlite: sha256Bytes(request.lanePatches.sqlite),
  };
  const committedPatches = request.mergePlanCommitment.input_lane_patch_sha;
  const decisionDigest = request.mergePlanCommitment.decision_digest;
  if (
    committedPatches === null ||
    typeof committedPatches !== "object" ||
    Array.isArray(committedPatches) ||
    (committedPatches as Record<string, unknown>).core !== patchSha.core ||
    (committedPatches as Record<string, unknown>).sqlite !== patchSha.sqlite ||
    typeof decisionDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(decisionDigest)
  ) {
    throw new ContainmentUnavailableError(
      "SJC1 actual-apply inputs are not exact commitment inputs",
    );
  }

  const beforeTree = await treeSha256(parentRoot);
  const corePatchPath = join(runtime, "core.patch");
  const sqlitePatchPath = join(runtime, "sqlite.patch");
  await writeFile(corePatchPath, request.lanePatches.core, { mode: 0o600, flag: "wx" });
  await writeFile(sqlitePatchPath, request.lanePatches.sqlite, {
    mode: 0o600,
    flag: "wx",
  });
  const home = join(runtime, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const environment = buildSeamActorEnvironment(request.env, {
    home,
    brokerOrigin: new URL(request.brokerOrigin).origin,
    cell: request.cell,
    lane: "core",
    capability: "runner-owned-actual-apply-capability",
  });
  delete environment.ORGANUM_CODE_SJC1_CAPABILITY;
  delete environment.ORGANUM_CODE_SJC1_LANE;
  const prepared = await prepareBackendContainment(
    {
      binary: request.gitBinary ?? "git",
      args: [
        "apply",
        "--no-index",
        "--whitespace=nowarn",
        "--",
        corePatchPath,
        sqlitePatchPath,
      ],
      env: environment,
      workspace: parentRoot,
      runtimeDirectory: runtime,
      brokerOrigin: request.brokerOrigin,
      immutablePaths: request.immutablePaths,
      allowPty: false,
    },
    dependencies,
  );
  let run: ExactSpawnResult;
  try {
    run = await runExactSpawn(prepared, "", request.timeoutMs ?? 15_000);
  } finally {
    await prepared.gate.close().catch(() => undefined);
  }
  if (run.timedOut || run.exitCode !== 0) {
    throw new ContainmentUnavailableError(
      `SJC1 actual apply failed closed (exit=${run.exitCode}, timeout=${run.timedOut}, output_sha256=${sha256SJC1({ stdout: sha256Bytes(run.stdout), stderr: sha256Bytes(run.stderr) })})`,
    );
  }
  const afterTree = await treeSha256(parentRoot);
  if (afterTree === beforeTree) {
    throw new ContainmentUnavailableError("SJC1 actual apply made no parent-tree change");
  }
  const actualApply: SJC1ActualApply = {
    input_lane_patch_sha256: patchSha,
    decision_digest: decisionDigest,
    conflict: false,
    apply_status: "applied",
    parent_tree_sha256: beforeTree,
    output_sha256: afterTree,
  };
  return {
    actualApply,
    rawEvidence: {
      schema: "organum-code/seam-joint-actual-apply-evidence/v1",
      containment_config_sha256: sha256SJC1(prepared.gate.config),
      input_lane_patch_sha256: patchSha,
      decision_digest: decisionDigest,
      parent_tree_sha256: beforeTree,
      output_sha256: afterTree,
      exit_code: run.exitCode,
      timed_out: run.timedOut,
      stdout_sha256: sha256Bytes(run.stdout),
      stderr_sha256: sha256Bytes(run.stderr),
    },
  };
}

export function assertSJC1RuntimePreconditions(path: string): void {
  if (!isAbsolute(path) || path.includes("\0") || !lstatSync(path).isDirectory()) {
    throw new ContainmentUnavailableError("SJC1 runtime precondition failed");
  }
}
