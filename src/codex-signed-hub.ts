import type { PublicationSnapshot } from "./coordination-publish.js";
import {
  SignedHubLifecycle,
  type SignedHubSnapshot,
  type SignedHubTurn,
} from "./grok-acp-signed-hub.js";
import { ConfigurationError } from "./provider-profile.js";

export const CODEX_SIGNED_HUB_FLAG = "--signed-hub" as const;

export interface CodexSignedHubCommand {
  kind: "signed-hub";
}

export interface CodexSignedHubCompletion {
  successful: boolean;
  signedHub: SignedHubSnapshot;
}

export interface CodexSignedHubLaunch {
  args: readonly string[];
  stdin: string;
}

export function parseCodexSignedHubCommand(
  args: readonly string[],
): CodexSignedHubCommand | null {
  if (!args.includes(CODEX_SIGNED_HUB_FLAG)) return null;
  if (args.length !== 1 || args[0] !== CODEX_SIGNED_HUB_FLAG) {
    throw new ConfigurationError(
      "Codex Signed Hub mode requires exactly `codex --signed-hub`; extra Codex arguments are not admitted",
    );
  }
  return { kind: "signed-hub" };
}

/**
 * Owns only the signed-message seam around the existing Codex launcher. The
 * launcher still owns broker containment and MCP projection; this adapter
 * supplies one admitted prompt and derives ACK success from durable handoff.
 */
export class CodexSignedHubAdapter {
  private readonly lifecycle: SignedHubLifecycle;
  private publicationBaselineBound = false;

  constructor(turn: SignedHubTurn) {
    this.lifecycle = new SignedHubLifecycle(turn);
  }

  async prepareLaunch(): Promise<CodexSignedHubLaunch> {
    const prompt = await this.lifecycle.prepare();
    // Codex documents '-' as its stdin prompt sentinel. Keeping the admitted
    // body off argv also avoids process-list disclosure and platform argv
    // length differences.
    return {
      args: ["exec", "--color", "never", "-"],
      stdin: prompt,
    };
  }

  bindPublicationBaseline(
    publication: Pick<PublicationSnapshot, "phase" | "receipt">,
  ): void {
    if (this.publicationBaselineBound) {
      throw new ConfigurationError(
        "Codex Signed Hub publication baseline must be bound exactly once",
      );
    }
    if (publication.phase !== "clean" || publication.receipt !== null) {
      throw new ConfigurationError(
        "Codex Signed Hub requires a fresh actor publication root; choose a new actor or reconcile the existing publication",
      );
    }
    this.publicationBaselineBound = true;
  }

  async beginExposure(): Promise<void> {
    if (!this.publicationBaselineBound) {
      throw new ConfigurationError(
        "Codex Signed Hub exposure requires a bound clean publication baseline",
      );
    }
    await this.lifecycle.beginExposure();
  }

  async complete(
    exitCode: number,
    publication: Pick<PublicationSnapshot, "phase" | "receipt"> | null,
  ): Promise<CodexSignedHubCompletion> {
    const successful =
      exitCode === 0 &&
      publication?.phase === "shipped" &&
      publication.receipt !== null;
    return {
      successful,
      signedHub: await this.lifecycle.complete(successful),
    };
  }
}
