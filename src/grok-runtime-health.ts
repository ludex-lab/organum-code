import {
  lstat,
  readdir,
  realpath,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const GROK_RECAP_WARN_BYTES = 64 * 1024 * 1024;
export const GROK_RECAP_ALERT_BYTES = 512 * 1024 * 1024;
export const GROK_RUNTIME_HEALTH_SCHEMA =
  "organum-code/grok-runtime-health/v1" as const;

const MAX_DISCOVERY_DEPTH = 4;
const MAX_INSPECTED_ENTRIES = 20_000;

export type GrokRuntimeHealthSeverity = "ok" | "warn" | "alert";
export type GrokRuntimeHealthPhase = "launch" | "settle";

export interface GrokRecapHealthFinding {
  path: string;
  sessionID: string;
  bytes: number;
  files: number;
  severity: Exclude<GrokRuntimeHealthSeverity, "ok">;
}

export interface GrokRuntimeHealthReport {
  schema: typeof GROK_RUNTIME_HEALTH_SCHEMA;
  runtimeDirectory: string;
  checkedAt: string;
  severity: GrokRuntimeHealthSeverity;
  recapDirectories: number;
  files: number;
  bytes: number;
  findings: GrokRecapHealthFinding[];
}

export type GrokRuntimeHealthObserver = (
  report: GrokRuntimeHealthReport,
  phase: GrokRuntimeHealthPhase,
) => void | Promise<void>;

export class GrokRuntimeHealthError extends Error {
  constructor(
    readonly report: GrokRuntimeHealthReport,
    readonly phase: GrokRuntimeHealthPhase,
  ) {
    const largest = [...report.findings].sort(
      (left, right) => right.bytes - left.bytes,
    )[0];
    super(
      `Grok actor runtime recap health is alert during ${phase}: ` +
        `${largest?.sessionID ?? "unknown-session"} has ` +
        `${formatMebibytes(largest?.bytes ?? report.bytes)} in ` +
        `${largest?.files ?? report.files} files; refusing to treat the ` +
        `${phase} boundary as healthy. No files were deleted.`,
    );
    this.name = "GrokRuntimeHealthError";
  }
}

interface TreeMeasurement {
  bytes: number;
  files: number;
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function severity(bytes: number): GrokRuntimeHealthSeverity {
  if (bytes >= GROK_RECAP_ALERT_BYTES) return "alert";
  if (bytes >= GROK_RECAP_WARN_BYTES) return "warn";
  return "ok";
}

async function metadata(path: string): Promise<
  Awaited<ReturnType<typeof lstat>> | null
> {
  return await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function countEntry(counter: { value: number }): void {
  counter.value += 1;
  if (counter.value > MAX_INSPECTED_ENTRIES) {
    throw new Error(
      `Grok actor runtime health inspection exceeded ${MAX_INSPECTED_ENTRIES} entries`,
    );
  }
}

async function findRecapDirectories(
  sessionsDirectory: string,
  counter: { value: number },
): Promise<string[]> {
  const root = await metadata(sessionsDirectory);
  if (root === null) return [];
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(
      "Grok actor runtime sessions path must be a real non-symlink directory",
    );
  }
  const pending = [{ path: sessionsDirectory, depth: 0 }];
  const found: string[] = [];
  while (pending.length > 0) {
    const current = pending.shift()!;
    const entries = await readdir(current.path, { withFileTypes: true });
    for (const entry of entries) {
      countEntry(counter);
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const path = join(current.path, entry.name);
      if (entry.name === "recap_requests") {
        found.push(path);
      } else if (current.depth < MAX_DISCOVERY_DEPTH) {
        pending.push({ path, depth: current.depth + 1 });
      }
    }
  }
  return found;
}

async function measureTree(
  root: string,
  counter: { value: number },
): Promise<TreeMeasurement> {
  const pending = [root];
  let bytes = 0;
  let files = 0;
  while (pending.length > 0) {
    const directory = pending.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      countEntry(counter);
      const path = join(directory, entry.name);
      const item = await lstat(path);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        pending.push(path);
      } else if (item.isFile()) {
        files += 1;
        bytes += item.size;
      }
    }
  }
  return { bytes, files };
}

export async function inspectGrokRuntimeHealth(
  runtimeDirectory: string,
): Promise<GrokRuntimeHealthReport> {
  const runtime = await realpath(runtimeDirectory);
  const counter = { value: 0 };
  const directories = await findRecapDirectories(
    join(runtime, "sessions"),
    counter,
  );
  const findings: GrokRecapHealthFinding[] = [];
  let bytes = 0;
  let files = 0;
  for (const path of directories) {
    const measured = await measureTree(path, counter);
    bytes += measured.bytes;
    files += measured.files;
    const level = severity(measured.bytes);
    if (level !== "ok") {
      findings.push({
        path,
        sessionID: basename(dirname(path)),
        bytes: measured.bytes,
        files: measured.files,
        severity: level,
      });
    }
  }
  const reportSeverity: GrokRuntimeHealthSeverity =
    findings.some((finding) => finding.severity === "alert")
      ? "alert"
      : findings.length > 0
        ? "warn"
        : "ok";
  return {
    schema: GROK_RUNTIME_HEALTH_SCHEMA,
    runtimeDirectory: runtime,
    checkedAt: new Date().toISOString(),
    severity: reportSeverity,
    recapDirectories: directories.length,
    files,
    bytes,
    findings,
  };
}

export async function enforceGrokRuntimeHealth(
  report: GrokRuntimeHealthReport,
  phase: GrokRuntimeHealthPhase,
  observer?: GrokRuntimeHealthObserver,
): Promise<void> {
  if (report.severity !== "ok") await observer?.(report, phase);
  if (report.severity === "alert") {
    throw new GrokRuntimeHealthError(report, phase);
  }
}

export function formatGrokRuntimeHealth(
  report: GrokRuntimeHealthReport,
  phase: GrokRuntimeHealthPhase,
): string {
  const largest = [...report.findings].sort(
    (left, right) => right.bytes - left.bytes,
  )[0];
  return [
    `Grok actor runtime health ${report.severity.toUpperCase()} at ${phase}:`,
    `${largest?.sessionID ?? "unknown-session"} recap_requests`,
    `${formatMebibytes(largest?.bytes ?? report.bytes)}`,
    `in ${largest?.files ?? report.files} files.`,
    "Read-only inspection; no files were deleted.",
  ].join(" ");
}
