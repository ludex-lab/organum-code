import type { PublicationSnapshot } from "./coordination-publish.js";
import {
  SignedHubLifecycle,
  type SignedHubSnapshot,
  type SignedHubTurn,
} from "./grok-acp-signed-hub.js";
import { ConfigurationError } from "./provider-profile.js";

export const CLAUDE_SIGNED_HUB_FLAG = "--signed-hub" as const;

export interface ClaudeSignedHubCommand {
  kind: "signed-hub";
}

export interface ClaudeSignedHubCompletion {
  successful: boolean;
  signedHub: SignedHubSnapshot;
}

export function parseClaudeSignedHubCommand(
  args: readonly string[],
): ClaudeSignedHubCommand | null {
  if (!args.includes(CLAUDE_SIGNED_HUB_FLAG)) return null;
  if (args.length !== 1 || args[0] !== CLAUDE_SIGNED_HUB_FLAG) {
    throw new ConfigurationError(
      "Claude Signed Hub mode requires exactly `claude --signed-hub`; extra Claude arguments are not admitted",
    );
  }
  return { kind: "signed-hub" };
}

/**
 * Claude runs as a read-only native-subscription critic. It returns one
 * bounded final result; the supervisor, not Claude, owns durable Organum
 * publication and the semantic ACK decision.
 */
export class ClaudeSignedHubAdapter {
  private readonly lifecycle: SignedHubLifecycle;
  private publicationBaselineBound = false;

  constructor(turn: SignedHubTurn) {
    this.lifecycle = new SignedHubLifecycle(turn);
  }

  async preparePrompt(): Promise<string> {
    return await this.lifecycle.prepare();
  }

  bindPublicationBaseline(
    publication: Pick<PublicationSnapshot, "phase" | "receipt">,
  ): void {
    if (this.publicationBaselineBound) {
      throw new ConfigurationError(
        "Claude Signed Hub publication baseline must be bound exactly once",
      );
    }
    if (publication.phase !== "clean" || publication.receipt !== null) {
      throw new ConfigurationError(
        "Claude Signed Hub requires a fresh actor publication root; choose a new actor or reconcile the existing publication",
      );
    }
    this.publicationBaselineBound = true;
  }

  async beginExposure(): Promise<void> {
    if (!this.publicationBaselineBound) {
      throw new ConfigurationError(
        "Claude Signed Hub exposure requires a bound clean publication baseline",
      );
    }
    await this.lifecycle.beginExposure();
  }

  async complete(
    providerSuccessful: boolean,
    publication: Pick<PublicationSnapshot, "phase" | "receipt"> | null,
  ): Promise<ClaudeSignedHubCompletion> {
    const successful =
      providerSuccessful &&
      publication?.phase === "shipped" &&
      publication.receipt !== null;
    return {
      successful,
      signedHub: await this.lifecycle.complete(successful),
    };
  }
}
