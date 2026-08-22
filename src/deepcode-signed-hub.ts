import type { PublicationSnapshot } from "./coordination-publish.js";
import {
  SignedHubLifecycle,
  type SignedHubSnapshot,
  type SignedHubTurn,
} from "./grok-acp-signed-hub.js";
import { ConfigurationError } from "./provider-profile.js";

export const DEEPCODE_SIGNED_HUB_FLAG = "--signed-hub" as const;

export interface DeepCodeSignedHubCommand {
  kind: "signed-hub";
}

export interface DeepCodeSignedHubCompletion {
  successful: boolean;
  signedHub: SignedHubSnapshot;
}

export interface DeepCodeSignedHubLaunch {
  args: readonly string[];
}

export function parseDeepCodeSignedHubCommand(
  args: readonly string[],
): DeepCodeSignedHubCommand | null {
  if (!args.includes(DEEPCODE_SIGNED_HUB_FLAG)) return null;
  if (args.length !== 1 || args[0] !== DEEPCODE_SIGNED_HUB_FLAG) {
    throw new ConfigurationError(
      "Deep Code Signed Hub mode requires exactly `deepcode --signed-hub`; extra Deep Code arguments are not admitted",
    );
  }
  return { kind: "signed-hub" };
}

/**
 * Owns the signed-message seam around the contained Deep Code launcher. Deep
 * Code 0.1.34 has no headless stdin protocol, so its exact admitted body is
 * supplied once through the native `-p` initial-prompt surface. The launcher
 * still owns the broker capability, outer containment, and bounded MCP
 * projection; applied ACK requires a durable supervisor-owned handoff.
 */
export class DeepCodeSignedHubAdapter {
  private readonly lifecycle: SignedHubLifecycle;
  private publicationBaselineBound = false;

  constructor(turn: SignedHubTurn) {
    this.lifecycle = new SignedHubLifecycle(turn);
  }

  async prepareLaunch(): Promise<DeepCodeSignedHubLaunch> {
    const prompt = await this.lifecycle.prepare();
    return { args: ["-p", prompt] };
  }

  bindPublicationBaseline(
    publication: Pick<PublicationSnapshot, "phase" | "receipt">,
  ): void {
    if (this.publicationBaselineBound) {
      throw new ConfigurationError(
        "Deep Code Signed Hub publication baseline must be bound exactly once",
      );
    }
    if (publication.phase !== "clean" || publication.receipt !== null) {
      throw new ConfigurationError(
        "Deep Code Signed Hub requires a fresh actor publication root; choose a new actor or reconcile the existing publication",
      );
    }
    this.publicationBaselineBound = true;
  }

  async beginExposure(): Promise<void> {
    if (!this.publicationBaselineBound) {
      throw new ConfigurationError(
        "Deep Code Signed Hub exposure requires a bound clean publication baseline",
      );
    }
    await this.lifecycle.beginExposure();
  }

  async complete(
    exitCode: number,
    publication: Pick<PublicationSnapshot, "phase" | "receipt"> | null,
  ): Promise<DeepCodeSignedHubCompletion> {
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
