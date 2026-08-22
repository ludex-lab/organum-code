import type { PublicationSnapshot } from "./coordination-publish.js";
import {
  SignedHubLifecycle,
  type SignedHubSnapshot,
  type SignedHubTurn,
} from "./grok-acp-signed-hub.js";
import { ConfigurationError } from "./provider-profile.js";

export const CURSOR_SIGNED_HUB_FLAG = "--signed-hub" as const;

export interface CursorSignedHubCommand {
  kind: "signed-hub";
}

export interface CursorSignedHubCompletion {
  successful: boolean;
  signedHub: SignedHubSnapshot;
}

export function parseCursorSignedHubCommand(
  args: readonly string[],
): CursorSignedHubCommand | null {
  if (!args.includes(CURSOR_SIGNED_HUB_FLAG)) return null;
  if (args.length !== 1 || args[0] !== CURSOR_SIGNED_HUB_FLAG) {
    throw new ConfigurationError(
      "Cursor Signed Hub mode requires exactly `cursor --signed-hub`; extra Cursor arguments are not admitted",
    );
  }
  return { kind: "signed-hub" };
}

/**
 * Cursor runs as a read-only native-subscription critic. It returns one
 * bounded final result; the supervisor, not the model, owns durable Organum
 * publication and the semantic ACK decision.
 */
export class CursorSignedHubAdapter {
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
        "Cursor Signed Hub publication baseline must be bound exactly once",
      );
    }
    if (publication.phase !== "clean" || publication.receipt !== null) {
      throw new ConfigurationError(
        "Cursor Signed Hub requires a fresh actor publication root; choose a new actor or reconcile the existing publication",
      );
    }
    this.publicationBaselineBound = true;
  }

  async beginExposure(): Promise<void> {
    if (!this.publicationBaselineBound) {
      throw new ConfigurationError(
        "Cursor Signed Hub exposure requires a bound clean publication baseline",
      );
    }
    await this.lifecycle.beginExposure();
  }

  async complete(
    providerSuccessful: boolean,
    publication: Pick<PublicationSnapshot, "phase" | "receipt"> | null,
  ): Promise<CursorSignedHubCompletion> {
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
