import type {
  RootSessionResolution,
  RootSessionResolver,
} from "./backend-session.js";

export type { RootSessionResolution } from "./backend-session.js";

export interface OpenCodeSessionRecord {
  id: string;
  parentID?: string;
}

export interface OpenCodeSessionLookupRequest {
  sessionID: string;
  directory: string;
  signal?: AbortSignal;
}

export type OpenCodeSessionLookup = (
  request: OpenCodeSessionLookupRequest,
) => Promise<OpenCodeSessionRecord>;

export class OpenCodeSessionResolutionError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "aborted"
      | "contract"
      | "cycle"
      | "depth"
      | "lookup",
  ) {
    super(message);
    this.name = "OpenCodeSessionResolutionError";
  }
}

export interface ResolveRootSessionOptions {
  maxDepth?: number;
  signal?: AbortSignal;
}

function nonempty(value: string, context: string): string {
  if (value.trim().length === 0) {
    throw new OpenCodeSessionResolutionError(
      `${context} must not be empty`,
      "contract",
    );
  }
  return value;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OpenCodeSessionResolutionError(
      "OpenCode root session resolution aborted",
      "aborted",
    );
  }
}

export async function resolveRootSession(
  sessionID: string,
  directory: string,
  lookup: OpenCodeSessionLookup,
  options: ResolveRootSessionOptions = {},
): Promise<RootSessionResolution> {
  const start = nonempty(sessionID, "OpenCode session ID");
  nonempty(directory, "OpenCode session directory");
  const maxDepth = options.maxDepth ?? 64;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new OpenCodeSessionResolutionError(
      "OpenCode root resolution maxDepth must be a positive integer",
      "contract",
    );
  }

  const lineage: string[] = [];
  const seen = new Set<string>();
  let current = start;

  while (true) {
    abortIfNeeded(options.signal);
    if (seen.has(current)) {
      throw new OpenCodeSessionResolutionError(
        `OpenCode session parent cycle detected at ${JSON.stringify(current)}`,
        "cycle",
      );
    }
    if (lineage.length >= maxDepth) {
      throw new OpenCodeSessionResolutionError(
        `OpenCode session parent chain exceeded ${maxDepth} entries`,
        "depth",
      );
    }
    seen.add(current);
    lineage.push(current);

    let record: OpenCodeSessionRecord;
    try {
      record = await lookup({
        sessionID: current,
        directory,
        signal: options.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) abortIfNeeded(options.signal);
      if (error instanceof OpenCodeSessionResolutionError) throw error;
      throw new OpenCodeSessionResolutionError(
        `Unable to inspect OpenCode session ${JSON.stringify(current)}`,
        "lookup",
      );
    }
    abortIfNeeded(options.signal);
    if (
      typeof record !== "object" ||
      record === null ||
      typeof record.id !== "string"
    ) {
      throw new OpenCodeSessionResolutionError(
        "OpenCode session lookup returned an invalid record",
        "contract",
      );
    }
    if (record.id !== current) {
      throw new OpenCodeSessionResolutionError(
        `OpenCode session lookup returned ${JSON.stringify(record.id)} for ${JSON.stringify(current)}`,
        "contract",
      );
    }
    if (record.parentID === undefined) {
      return { rootSessionID: current, lineage };
    }
    if (typeof record.parentID !== "string") {
      throw new OpenCodeSessionResolutionError(
        "OpenCode session parentID must be a string when present",
        "contract",
      );
    }
    current = nonempty(record.parentID, "OpenCode parent session ID");
  }
}

function cacheKey(directory: string, sessionID: string): string {
  return `${directory}\0${sessionID}`;
}

export class OpenCodeRootSessionResolver implements RootSessionResolver {
  private readonly roots = new Map<string, RootSessionResolution>();

  constructor(
    private readonly lookup: OpenCodeSessionLookup,
    private readonly maxDepth = 64,
  ) {}

  async resolve(
    sessionID: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<RootSessionResolution> {
    abortIfNeeded(signal);
    const cached = this.roots.get(cacheKey(directory, sessionID));
    if (cached !== undefined) {
      return {
        rootSessionID: cached.rootSessionID,
        lineage: [...cached.lineage],
      };
    }

    const resolution = await resolveRootSession(sessionID, directory, this.lookup, {
      maxDepth: this.maxDepth,
      signal,
    });
    for (const [index, member] of resolution.lineage.entries()) {
      this.roots.set(cacheKey(directory, member), {
        rootSessionID: resolution.rootSessionID,
        lineage: resolution.lineage.slice(index),
      });
    }
    return resolution;
  }

  clear(directory?: string): void {
    if (directory === undefined) {
      this.roots.clear();
      return;
    }
    const prefix = `${directory}\0`;
    for (const key of this.roots.keys()) {
      if (key.startsWith(prefix)) this.roots.delete(key);
    }
  }
}
