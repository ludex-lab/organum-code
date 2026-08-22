import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import type { PublicationSnapshot } from "./coordination-publish.js";
import type { PollingStatus } from "./coordination-polling.js";
import { ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV } from "./plugin-protocol.js";

export { ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV };

export const OPENCODE_CAST_RECEIPT_SCHEMA =
  "organum-code/opencode-cast-receipt/v1" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const countSchema = z.number().int().nonnegative();
const cellSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const phaseSchema = z.enum([
  "clean",
  "output_pending",
  "reminded_once",
  "publishing",
  "published",
  "publish_failed",
  "ending",
  "end_failed",
  "shipped",
  "nonconformant",
]);

export const openCodeCastReceiptSchema = z.object({
  schema: z.literal(OPENCODE_CAST_RECEIPT_SCHEMA),
  root_session_id: z.string().min(1).max(256),
  canonical_cell: cellSchema,
  updated_at: z.string().datetime(),
  delivery: z.object({
    schema: z.literal("organum-code/native-coordination-delivery/v1"),
    polls: countSchema,
    prepared_turns: countSchema,
    admitted_turns: countSchema,
    exposed_items: countSchema,
    admitted_items: countSchema,
    relay_acks: countSchema,
    last_turn_id: z.string().min(1).max(256).nullable(),
    last_packet_sha256: sha256Schema.nullable(),
    last_polling_status: z.enum([
      "fresh",
      "partial",
      "stale",
      "unavailable",
    ]).nullable(),
  }).strict(),
  publication: z.object({
    phase: phaseSchema,
    receipt: z.object({
      channel: z.enum(["agora", "relay"]),
      to: z.string().max(128).nullable(),
      file: z.string().min(1).max(512),
      from_id: cellSchema,
      topic: z.string().max(128).nullable(),
      body_bytes: countSchema,
      body_sha256: sha256Schema,
    }).strict().nullable(),
  }).strict(),
}).strict().superRefine((value, context) => {
  const delivery = value.delivery;
  if (
    delivery.admitted_turns > delivery.prepared_turns ||
    delivery.admitted_items > delivery.exposed_items ||
    delivery.relay_acks > delivery.admitted_items
  ) {
    context.addIssue({
      code: "custom",
      path: ["delivery"],
      message: "OpenCode cast delivery counters violate conservation",
    });
  }
  if (
    value.publication.receipt !== null &&
    value.publication.receipt.from_id !== value.canonical_cell
  ) {
    context.addIssue({
      code: "custom",
      path: ["publication", "receipt", "from_id"],
      message: "OpenCode cast publication identity must match the canonical cell",
    });
  }
});

export type OpenCodeCastReceipt = z.infer<typeof openCodeCastReceiptSchema>;
export type OpenCodeCastDelivery = OpenCodeCastReceipt["delivery"];

function inside(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function assertPrivateDirectory(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error("OpenCode cast receipt directory must be private and real");
  }
  return await realpath(path);
}

export async function prepareOpenCodeCastReceipt(
  runDirectory: string,
  laneID: string,
  workspace: string,
): Promise<string> {
  if (
    !isAbsolute(runDirectory) ||
    runDirectory.includes("\0") ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(laneID)
  ) {
    throw new Error("OpenCode cast receipt requires an absolute run directory and canonical lane ID");
  }
  const directory = join(resolve(runDirectory), "opencode-cast-receipts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonicalDirectory = await assertPrivateDirectory(directory);
  const canonicalWorkspace = await realpath(workspace);
  if (
    inside(canonicalWorkspace, canonicalDirectory) ||
    inside(canonicalDirectory, canonicalWorkspace)
  ) {
    throw new Error("OpenCode cast receipt directory must be disjoint from the workspace");
  }
  const path = join(canonicalDirectory, `${laneID}.json`);
  const existing = await lstat(path).catch(() => null);
  if (existing !== null) {
    throw new Error("OpenCode cast receipt already exists; use a fresh run directory");
  }
  return path;
}

export async function validateOpenCodeCastReceiptPath(
  rawPath: string,
  workspace: string,
): Promise<string> {
  if (
    !isAbsolute(rawPath) ||
    rawPath.includes("\0") ||
    Buffer.byteLength(rawPath, "utf8") > 4_096
  ) {
    throw new Error(`${ORGANUM_CODE_OPENCODE_CAST_RECEIPT_ENV} must be a bounded absolute path`);
  }
  const canonicalDirectory = await assertPrivateDirectory(dirname(rawPath));
  const canonicalWorkspace = await realpath(workspace);
  if (
    inside(canonicalWorkspace, canonicalDirectory) ||
    inside(canonicalDirectory, canonicalWorkspace)
  ) {
    throw new Error("OpenCode cast receipt path must be disjoint from the workspace");
  }
  return join(canonicalDirectory, basename(rawPath));
}

export function openCodeCastReceipt(
  rootSessionID: string,
  canonicalCell: string,
  delivery: OpenCodeCastDelivery,
  publication: PublicationSnapshot,
  now: Date = new Date(),
): OpenCodeCastReceipt {
  return openCodeCastReceiptSchema.parse({
    schema: OPENCODE_CAST_RECEIPT_SCHEMA,
    root_session_id: rootSessionID,
    canonical_cell: canonicalCell,
    updated_at: now.toISOString(),
    delivery,
    publication: {
      phase: publication.phase,
      receipt: publication.receipt === null
        ? null
        : {
            channel: publication.receipt.channel,
            to: publication.receipt.to,
            file: publication.receipt.file,
            from_id: publication.receipt.from_id,
            topic: publication.receipt.topic,
            body_bytes: publication.receipt.body_bytes,
            body_sha256: publication.receipt.body_sha256,
          },
    },
  });
}

export async function writeOpenCodeCastReceipt(
  path: string,
  receipt: OpenCodeCastReceipt,
): Promise<void> {
  const parsed = openCodeCastReceiptSchema.parse(receipt);
  const temporary = join(
    dirname(path),
    `.${randomUUID()}.opencode-cast-receipt.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readOpenCodeCastReceipt(
  path: string,
): Promise<OpenCodeCastReceipt> {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 64 * 1024 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error("OpenCode cast receipt must be one bounded private regular file");
  }
  return openCodeCastReceiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export function initialOpenCodeCastDelivery(): OpenCodeCastDelivery {
  return {
    schema: "organum-code/native-coordination-delivery/v1",
    polls: 0,
    prepared_turns: 0,
    admitted_turns: 0,
    exposed_items: 0,
    admitted_items: 0,
    relay_acks: 0,
    last_turn_id: null,
    last_packet_sha256: null,
    last_polling_status: null,
  };
}

export function updateOpenCodeCastDelivery(
  delivery: OpenCodeCastDelivery,
  update: {
    turnID: string;
    packetSha256: string;
    pollingStatus: PollingStatus;
    exposedItems: number;
  },
): void {
  delivery.polls += 1;
  delivery.prepared_turns += 1;
  delivery.exposed_items += update.exposedItems;
  delivery.last_turn_id = update.turnID;
  delivery.last_packet_sha256 = update.packetSha256;
  delivery.last_polling_status = update.pollingStatus;
}
