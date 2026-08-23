export const CANONICAL_BUN_VERSION = "1.3.14";
export const SUPPORTED_BUN_CONSUMER_VERSIONS = [
  CANONICAL_BUN_VERSION,
  "1.4.0",
] as const;

export function currentBunVersion(
  value: unknown = (globalThis as { Bun?: unknown }).Bun,
): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    typeof value.version === "string"
  ) {
    return value.version;
  }
  return undefined;
}

export function assertCanonicalBunRuntime(
  version: string | undefined,
): void {
  if (version !== undefined && version !== CANONICAL_BUN_VERSION) {
    throw new Error(
      `Bun ${CANONICAL_BUN_VERSION} is required; found Bun ${version}`,
    );
  }
}

export function assertSupportedBunConsumerRuntime(
  version: string | undefined,
): void {
  if (
    version !== undefined &&
    !(SUPPORTED_BUN_CONSUMER_VERSIONS as readonly string[]).includes(version)
  ) {
    throw new Error(
      `Bun ${SUPPORTED_BUN_CONSUMER_VERSIONS.join(" or ")} is required; found Bun ${version}`,
    );
  }
}
