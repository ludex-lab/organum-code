/**
 * Backend-neutral session topology seen by the coordination layer.
 *
 * A backend may expose a parent/child session tree (OpenCode), a single stable
 * root (Claude Code print/session mode), or obtain this shape through ACP. The
 * Organum coordination state machine only needs this resolved projection.
 */
export interface RootSessionResolution {
  rootSessionID: string;
  lineage: string[];
}

export interface RootSessionResolver {
  resolve(
    sessionID: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<RootSessionResolution>;
}

export class DirectRootSessionResolver implements RootSessionResolver {
  constructor(private readonly backendName: string) {}

  async resolve(
    sessionID: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<RootSessionResolution> {
    if (signal?.aborted) {
      throw new DOMException(
        `${this.backendName} root session resolution aborted`,
        "AbortError",
      );
    }
    if (sessionID.trim().length === 0) {
      throw new TypeError(`${this.backendName} session ID must not be empty`);
    }
    if (directory.trim().length === 0) {
      throw new TypeError(`${this.backendName} session directory must not be empty`);
    }
    return { rootSessionID: sessionID, lineage: [sessionID] };
  }
}
