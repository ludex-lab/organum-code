import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BUN_LICENSE_PATH = "licenses/BUN-1.3.14-LICENSE.md";
const BUN_LICENSE_SHA256 =
  "2cb858b2db8fc793bca2093489c5bc8eee615d002cc4924254904044c27a0afa";

const RUNTIME_PACKAGES = [
  {
    directory: "node_modules/@anthropic-ai/sandbox-runtime",
    name: "@anthropic-ai/sandbox-runtime",
    version: "0.0.50",
    license: "Apache-2.0",
    dependencies: {
      "@pondwader/socks5-server": "^1.0.10",
      commander: "^12.1.0",
      "shell-quote": "^1.8.3",
      zod: "^3.24.1",
    },
  },
  {
    directory: "node_modules/@pondwader/socks5-server",
    name: "@pondwader/socks5-server",
    version: "1.0.10",
    license: "MIT",
    dependencies: {},
  },
  {
    directory: "node_modules/commander",
    name: "commander",
    version: "12.1.0",
    license: "MIT",
    dependencies: {},
  },
  {
    directory: "node_modules/shell-quote",
    name: "shell-quote",
    version: "1.8.3",
    license: "MIT",
    dependencies: {},
  },
  {
    directory: "node_modules/zod",
    name: "zod",
    version: "4.1.8",
    license: "MIT",
    dependencies: {},
  },
  {
    directory: "node_modules/@anthropic-ai/sandbox-runtime/node_modules/shell-quote",
    name: "shell-quote",
    version: "1.10.0",
    license: "MIT",
    dependencies: {},
  },
  {
    directory: "node_modules/@anthropic-ai/sandbox-runtime/node_modules/zod",
    name: "zod",
    version: "3.25.76",
    license: "MIT",
    dependencies: {},
  },
] as const;

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function normalizedLicense(body: string): string {
  return body.replace(/\r\n/gu, "\n").trimEnd();
}

function assertExactDependencies(
  label: string,
  actual: unknown,
  expected: Readonly<Record<string, string>>,
): void {
  if (
    typeof actual !== "object" ||
    actual === null ||
    Array.isArray(actual) ||
    JSON.stringify(Object.entries(actual).sort()) !==
      JSON.stringify(Object.entries(expected).sort())
  ) {
    throw new Error(`Runtime dependency graph drift for ${label}`);
  }
}

export async function generateThirdPartyNotices(
  projectRoot = PROJECT_ROOT,
): Promise<string> {
  const rootMetadata = JSON.parse(
    await readFile(resolve(projectRoot, "package.json"), "utf8"),
  ) as { dependencies?: unknown };
  assertExactDependencies("package.json", rootMetadata.dependencies, {
    "@anthropic-ai/sandbox-runtime": "0.0.50",
    "shell-quote": "1.8.3",
    zod: "4.1.8",
  });
  const bunLicense = await readFile(resolve(projectRoot, BUN_LICENSE_PATH), "utf8");
  if (sha256(bunLicense) !== BUN_LICENSE_SHA256) {
    throw new Error("Pinned Bun 1.3.14 license text failed its SHA-256 check");
  }

  const sections = [
    "THIRD-PARTY SOFTWARE NOTICES",
    "============================",
    "",
    "This file covers the runtime and production dependency material shipped in",
    "the Organum Code standalone preview. Development-only packages are omitted.",
    "",
    "Bun 1.3.14",
    "----------",
    "Source: https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md",
    "",
    normalizedLicense(bunLicense),
  ];

  for (const expected of RUNTIME_PACKAGES) {
    const directory = resolve(projectRoot, expected.directory);
    const metadata = JSON.parse(
      await readFile(resolve(directory, "package.json"), "utf8"),
    ) as {
      name?: unknown;
      version?: unknown;
      license?: unknown;
      dependencies?: unknown;
    };
    if (
      metadata.name !== expected.name ||
      metadata.version !== expected.version ||
      metadata.license !== expected.license
    ) {
      throw new Error(
        `Runtime dependency drift for ${expected.directory}: expected ${expected.name}@${expected.version} (${expected.license})`,
      );
    }
    assertExactDependencies(
      `${expected.name}@${expected.version}`,
      metadata.dependencies ?? {},
      expected.dependencies,
    );
    const licenseBody = normalizedLicense(
      await readFile(resolve(directory, "LICENSE"), "utf8"),
    );
    const title = `${expected.name}@${expected.version} (${expected.license})`;
    sections.push("", title, "-".repeat(title.length), "", licenseBody);
  }
  return `${sections.join("\n")}\n`;
}

async function replaceText(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length > 2 || (args.length === 2 && args[0] !== "--output")) {
    throw new Error("usage: generate-third-party-notices [--output PATH]");
  }
  const output = resolve(args[1] ?? "dist/THIRD_PARTY_NOTICES.txt");
  const body = await generateThirdPartyNotices(PROJECT_ROOT);
  await replaceText(output, body);
  console.log(JSON.stringify({ output, bytes: Buffer.byteLength(body), sha256: sha256(body) }));
}

if (import.meta.main) await main(process.argv.slice(2));
