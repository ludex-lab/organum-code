import { createHash } from "node:crypto";

const CELL_ID_PATTERN = /^[A-Za-z0-9_-](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9_-])?$/;
const ROOT_ID_DOMAIN = "organum-code/opencode-root/v1";
const GROK_ACP_ROOT_ID_DOMAIN = "organum-code/grok-acp-root/v1";
const CLAUDE_ROOT_ID_DOMAIN = "organum-code/claude-root/v1";
const DEEPCODE_ROOT_ID_DOMAIN = "organum-code/deepcode-root/v1";
const CODEX_ROOT_ID_DOMAIN = "organum-code/codex-root/v1";
const CURSOR_ROOT_ID_DOMAIN = "organum-code/cursor-root/v1";
const PUBLISH_IDEMPOTENCY_DOMAIN = "organum-code/publish/v1";

declare const cellIdentityBrand: unique symbol;

export type CellIdentity = string & {
  readonly [cellIdentityBrand]: "CellIdentity";
};

export type NativeRootBackend =
  | "claude"
  | "grok"
  | "deepcode"
  | "codex"
  | "cursor";

export function isValidCellIdentity(value: string): boolean {
  return value.length >= 1 && value.length <= 40 && CELL_ID_PATTERN.test(value);
}

export function parseCellIdentity(value: string): CellIdentity {
  if (!isValidCellIdentity(value)) {
    throw new Error(
      "Organum cell identity must be 1-40 ASCII letters, numbers, dots, underscores, or hyphens, without a leading or trailing dot",
    );
  }
  return value.toLowerCase() as CellIdentity;
}

export function deriveCellIdentity(rootSessionID: string): CellIdentity {
  if (rootSessionID.length === 0) {
    throw new Error("OpenCode root session ID must not be empty");
  }

  const digest = createHash("sha256")
    .update(ROOT_ID_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(rootSessionID, "utf8")
    .digest("hex");

  return parseCellIdentity(`oc-${digest.slice(0, 36)}`);
}

/**
 * Frozen Grok ACP root identity mapping.
 *
 * ACP session IDs are backend-owned opaque strings. Domain separation keeps
 * the same textual ID in OpenCode and Grok from ever sharing one Organum cell.
 */
export function deriveGrokAcpCellIdentity(
  rootSessionID: string,
): CellIdentity {
  return deriveNativeCellIdentity("grok", rootSessionID);
}

/**
 * Frozen root identity mapping for supervisor-owned native backend roots.
 *
 * The root ID is stable supervisor state and is deliberately independent from
 * an individual backend process or compacted transcript. Grok retains its
 * already-shipped ACP namespace.
 */
export function deriveNativeCellIdentity(
  backend: NativeRootBackend,
  rootSessionID: string,
): CellIdentity {
  if (rootSessionID.length === 0) {
    throw new Error(`${backend} root session ID must not be empty`);
  }

  const domain =
    backend === "claude"
      ? CLAUDE_ROOT_ID_DOMAIN
      : backend === "grok"
        ? GROK_ACP_ROOT_ID_DOMAIN
        : backend === "deepcode"
          ? DEEPCODE_ROOT_ID_DOMAIN
          : backend === "codex"
            ? CODEX_ROOT_ID_DOMAIN
            : CURSOR_ROOT_ID_DOMAIN;
  const prefix =
    backend === "claude"
      ? "claude-"
      : backend === "grok"
        ? "grok-"
        : backend === "deepcode"
          ? "deep-"
          : backend === "codex"
            ? "codex-"
            : "cursor-";
  const digestLength = 40 - prefix.length;
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(rootSessionID, "utf8")
    .digest("hex");

  return parseCellIdentity(`${prefix}${digest.slice(0, digestLength)}`);
}

export function derivePublishIdempotencyKey(
  identity: CellIdentity,
  turnID: string,
  content: string,
): string {
  if (turnID.length === 0) {
    throw new Error("OpenCode turn ID must not be empty");
  }
  if (content.trim().length === 0) {
    throw new Error("Publish content must not be empty");
  }

  return createHash("sha256")
    .update(PUBLISH_IDEMPOTENCY_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(identity, "utf8")
    .update("\0", "utf8")
    .update(turnID, "utf8")
    .update("\0", "utf8")
    .update(content, "utf8")
    .digest("hex");
}
