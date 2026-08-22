import { constants } from "node:fs";
import {
  access,
  lstat,
  readFile,
  realpath,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

import { ORGANUM_CODE_PROJECT_CONTRACT_ENV } from "./plugin-protocol.js";
export { ORGANUM_CODE_PROJECT_CONTRACT_ENV };

export const PROJECT_ENVIRONMENT_PROTOCOL = 1;
export const PROJECT_ENVIRONMENT_MAX_BYTES = 2 * 1024;
const MAX_DISCOVERY_FILE_BYTES = 256 * 1024;
const MAX_INSTRUCTION_BYTES = 1024;
const MAX_SCRIPT_BYTES = 256;

export interface ProjectInstruction {
  source: string;
  text: string;
  truncated: boolean;
}

export interface ProjectCommand {
  kind: "build" | "check" | "lint" | "test" | "typecheck";
  command: string;
  env: Record<string, string>;
  provenance: string;
  executable: string;
  resolved_executable?: string;
  executable_found: boolean;
}

export interface ProjectEnvironmentPacket {
  protocol: number;
  instructions: ProjectInstruction[];
  commands: ProjectCommand[];
  warnings: string[];
}

export class ProjectContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectContractError";
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function truncateUtf8(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false };
  }
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = characters.slice(0, middle).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { text: characters.slice(0, low).join(""), truncated: true };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readRegularFile(path: string): Promise<string | null> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ProjectContractError(
      `Project contract source must be a regular non-symlink file: ${path}`,
    );
  }
  if (stats.size > MAX_DISCOVERY_FILE_BYTES) {
    throw new ProjectContractError(
      `Project contract source exceeds ${MAX_DISCOVERY_FILE_BYTES} bytes: ${path}`,
    );
  }
  return await readFile(path, "utf8");
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

async function instructionSource(
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ path: string; content: string } | null> {
  const explicit = environment[ORGANUM_CODE_PROJECT_CONTRACT_ENV]?.trim();
  if (explicit) {
    if (
      explicit.includes("\0") ||
      Buffer.byteLength(explicit, "utf8") > 1024
    ) {
      throw new ProjectContractError(
        `${ORGANUM_CODE_PROJECT_CONTRACT_ENV} must be a path of at most 1024 UTF-8 bytes`,
      );
    }
    const path = isAbsolute(explicit) ? explicit : resolve(directory, explicit);
    const content = await readRegularFile(path);
    if (content === null) {
      throw new ProjectContractError(
        `Explicit project contract does not exist: ${path}`,
      );
    }
    return { path: await realpath(path), content };
  }

  const canonicalRoot = await realpath(directory);
  for (const name of ["AGENTS.md", "CONTRACT.md", "CLAUDE.md"]) {
    const path = join(canonicalRoot, name);
    const content = await readRegularFile(path);
    if (content === null) continue;
    const canonicalPath = await realpath(path);
    if (!inside(canonicalRoot, canonicalPath)) {
      throw new ProjectContractError(
        `Discovered project contract escaped the project root: ${path}`,
      );
    }
    return { path: canonicalPath, content };
  }
  return null;
}

async function resolveExecutableOnPath(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (executable.includes("/") || executable.includes("\\")) {
    return await access(executable, constants.X_OK).then(
      () => resolve(executable),
      () => null,
    );
  }
  const extensions =
    process.platform === "win32"
      ? (environment.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension}`);
      if (
        await access(candidate, constants.X_OK).then(
          () => true,
          () => false,
        )
      ) {
        return resolve(candidate);
      }
    }
  }
  return null;
}

function shellExecutable(executable: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(executable)) return executable;
  if (process.platform === "win32") return `"${executable}"`;
  return `'${executable.replaceAll("'", `'\\''`)}'`;
}

function packageRunner(packageManager: unknown): {
  executable: string;
  command: (executable: string, script: string) => string;
} {
  if (typeof packageManager === "string") {
    if (packageManager.startsWith("bun@")) {
      return {
        executable: "bun",
        command: (executable, script) => `${executable} run ${script}`,
      };
    }
    if (packageManager.startsWith("pnpm@")) {
      return {
        executable: "pnpm",
        command: (executable, script) => `${executable} run ${script}`,
      };
    }
    if (packageManager.startsWith("yarn@")) {
      return {
        executable: "yarn",
        command: (executable, script) => `${executable} ${script}`,
      };
    }
  }
  return {
    executable: "npm",
    command: (executable, script) => `${executable} run ${script}`,
  };
}

async function packageCommands(
  directory: string,
  environment: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<ProjectCommand[]> {
  const path = join(directory, "package.json");
  const content = await readRegularFile(path);
  if (content === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    warnings.push("package.json is invalid JSON; package commands were skipped.");
    return [];
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warnings.push("package.json root is not an object; package commands were skipped.");
    return [];
  }
  const packageValue = value as Record<string, unknown>;
  const scripts = packageValue.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return [];
  }
  const runner = packageRunner(packageValue.packageManager);
  const resolvedExecutable = await resolveExecutableOnPath(
    runner.executable,
    environment,
  );
  const commandExecutable = shellExecutable(
    resolvedExecutable ?? runner.executable,
  );
  const result: ProjectCommand[] = [];
  for (const kind of ["test", "check", "lint", "build", "typecheck"] as const) {
    const script = (scripts as Record<string, unknown>)[kind];
    if (typeof script !== "string") continue;
    const bounded = truncateUtf8(script, MAX_SCRIPT_BYTES);
    result.push({
      kind,
      command: runner.command(commandExecutable, kind),
      env: {},
      provenance: `${path}#scripts.${kind}: ${bounded.text}${bounded.truncated ? "…" : ""}`,
      executable: runner.executable,
      ...(resolvedExecutable === null
        ? {}
        : { resolved_executable: resolvedExecutable }),
      executable_found: resolvedExecutable !== null,
    });
  }
  return result;
}

async function pythonTestCommand(
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<ProjectCommand | null> {
  const pyprojectPath = join(directory, "pyproject.toml");
  const pytestPath = join(directory, "pytest.ini");
  const pyproject = await readRegularFile(pyprojectPath);
  const pytest = await readRegularFile(pytestPath);
  const inferredFromTests =
    pytest === null &&
    pyproject === null &&
    (await directoryExists(join(directory, "tests")));
  if (
    !inferredFromTests &&
    pytest === null &&
    (pyproject === null || !/^\[tool\.pytest\.ini_options\]/m.test(pyproject))
  ) {
    return null;
  }
  const hasUvLock = await regularFileExists(join(directory, "uv.lock"));
  let executable = "python3";
  let resolvedExecutable = await resolveExecutableOnPath(
    executable,
    environment,
  );
  if (hasUvLock) {
    const resolvedUv = await resolveExecutableOnPath("uv", environment);
    if (resolvedUv !== null) {
      executable = "uv";
      resolvedExecutable = resolvedUv;
    }
  }
  if (executable === "python3" && resolvedExecutable === null) {
    executable = "python";
    resolvedExecutable = await resolveExecutableOnPath(executable, environment);
  }
  if (executable === "uv") {
    executable = "uv";
  }
  const commandExecutable = shellExecutable(
    resolvedExecutable ?? executable,
  );
  const command =
    executable === "uv"
      ? `${commandExecutable} run pytest`
      : `${commandExecutable} -m pytest`;
  const configuredPythonPath = pyproject?.match(
    /^pythonpath\s*=\s*(?:\[\s*)?["']([^"']+)["']/m,
  )?.[1];
  const pythonPath =
    configuredPythonPath ??
    ((await directoryExists(join(directory, "src"))) ? "src" : undefined);
  return {
    kind: "test",
    command,
    env: pythonPath ? { PYTHONPATH: pythonPath } : {},
    provenance: inferredFromTests
      ? `${join(directory, "tests")}/ (inferred pytest layout)`
      : pytest === null
        ? pyprojectPath
        : pytestPath,
    executable,
    ...(resolvedExecutable === null
      ? {}
      : { resolved_executable: resolvedExecutable }),
    executable_found: resolvedExecutable !== null,
  };
}

function fitPacket(packet: ProjectEnvironmentPacket): ProjectEnvironmentPacket {
  while (
    jsonBytes(packet) > PROJECT_ENVIRONMENT_MAX_BYTES &&
    packet.commands.length > 1
  ) {
    packet.commands.pop();
  }
  const instruction = packet.instructions[0];
  if (instruction !== undefined && jsonBytes(packet) > PROJECT_ENVIRONMENT_MAX_BYTES) {
    let low = 0;
    let high = Array.from(instruction.text).length;
    const original = instruction.text;
    const characters = Array.from(original);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      instruction.text = characters.slice(0, middle).join("");
      instruction.truncated = true;
      if (jsonBytes(packet) <= PROJECT_ENVIRONMENT_MAX_BYTES) low = middle;
      else high = middle - 1;
    }
    instruction.text = characters.slice(0, low).join("");
    instruction.truncated = low < characters.length;
  }
  if (jsonBytes(packet) > PROJECT_ENVIRONMENT_MAX_BYTES) {
    throw new ProjectContractError(
      "Project environment packet cannot fit its hard envelope",
    );
  }
  return packet;
}

export async function loadProjectEnvironment(
  directory: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ProjectEnvironmentPacket> {
  if (!isAbsolute(directory)) {
    throw new ProjectContractError("OpenCode project directory must be absolute");
  }
  const warnings: string[] = [];
  const instruction = await instructionSource(directory, environment);
  const commands = await packageCommands(directory, environment, warnings);
  if (!commands.some((command) => command.kind === "test")) {
    const python = await pythonTestCommand(directory, environment);
    if (python !== null) commands.unshift(python);
  }
  const boundedInstruction =
    instruction === null
      ? []
      : [
          {
            source: instruction.path,
            ...truncateUtf8(instruction.content, MAX_INSTRUCTION_BYTES),
          },
        ];
  for (const command of commands) {
    if (!command.executable_found) {
      warnings.push(
        `${command.executable} was not found on PATH; ${command.kind} command is declared but unverified.`,
      );
    }
  }
  return fitPacket({
    protocol: PROJECT_ENVIRONMENT_PROTOCOL,
    instructions: boundedInstruction,
    commands,
    warnings: warnings.slice(0, 3).map((warning) =>
      truncateUtf8(warning, 192).text,
    ),
  });
}
