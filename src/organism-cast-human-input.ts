import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const ORGANISM_CAST_HUMAN_INPUT_REQUEST_SCHEMA =
  "organum-code/human-input-request/v1" as const;
export const ORGANISM_CAST_HUMAN_INPUT_RESPONSE_SCHEMA =
  "organum-code/human-input-response/v1" as const;
export const ORGANISM_CAST_HUMAN_INPUT_RECEIPT_SCHEMA =
  "organum-code/human-input-receipt/v1" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_HUMAN_INPUT_RECORD_BYTES = 16 * 1024;

const requestSchema = z
  .object({
    schema: z.literal(ORGANISM_CAST_HUMAN_INPUT_REQUEST_SCHEMA),
    run_id: z.string().min(1).max(64),
    lane_id: z.string().min(1).max(64),
    backend: z.enum(["opencode", "claude", "grok", "deepcode", "codex"]),
    state: z.literal("blocked_on_human_input"),
    blocked_at: z.iso.datetime(),
    question_id: z.string().regex(SHA256_PATTERN),
    question: z.string().min(1).max(8_192),
  })
  .strict();

const receiptSchema = z
  .object({
    schema: z.literal(ORGANISM_CAST_HUMAN_INPUT_RECEIPT_SCHEMA),
    question_id: z.string().regex(SHA256_PATTERN),
    status: z.literal("answered"),
    answered_at: z.iso.datetime(),
  })
  .strict();

export interface OrganismCastHumanInputPaths {
  rootDirectory: string;
  requestDirectory: string;
  responseDirectory: string;
  receiptDirectory: string;
}

export interface OrganismCastHumanInputEvent {
  state: "answered" | "blocked_on_human_input";
  blocked_at: string;
  question_id: string;
  question: string;
  answered_at: string | null;
}

export function organismCastHumanInputPaths(
  stateDirectory: string,
  laneID: string,
): OrganismCastHumanInputPaths {
  const rootDirectory = join(stateDirectory, "human-input", laneID);
  return {
    rootDirectory,
    requestDirectory: join(rootDirectory, "requests"),
    responseDirectory: join(rootDirectory, "responses"),
    receiptDirectory: join(rootDirectory, "receipts"),
  };
}

async function readPrivateRecord(path: string): Promise<unknown | null> {
  const metadata = await lstat(path).catch(() => null);
  if (
    metadata === null ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > MAX_HUMAN_INPUT_RECORD_BYTES
  ) {
    return null;
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function readOrganismCastHumanInputEvents(
  paths: OrganismCastHumanInputPaths,
  expected: {
    runID: string;
    laneID: string;
    backend: "opencode" | "claude" | "grok" | "deepcode" | "codex";
  },
): Promise<OrganismCastHumanInputEvent[]> {
  const names = await readdir(paths.requestDirectory).catch(() => []);
  const events: OrganismCastHumanInputEvent[] = [];
  for (const name of names.sort()) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
    const decoded = await readPrivateRecord(join(paths.requestDirectory, name));
    const parsed = requestSchema.safeParse(decoded);
    if (
      !parsed.success ||
      parsed.data.run_id !== expected.runID ||
      parsed.data.lane_id !== expected.laneID ||
      parsed.data.backend !== expected.backend ||
      `${parsed.data.question_id}.json` !== name ||
      createHash("sha256")
          .update(parsed.data.question, "utf8")
          .digest("hex") !== parsed.data.question_id
    ) {
      continue;
    }
    const receipt = receiptSchema.safeParse(
      await readPrivateRecord(
        join(paths.receiptDirectory, `${parsed.data.question_id}.json`),
      ),
    );
    const answeredAt =
      receipt.success &&
        receipt.data.question_id === parsed.data.question_id
        ? receipt.data.answered_at
        : null;
    events.push({
      state: answeredAt === null ? "blocked_on_human_input" : "answered",
      blocked_at: parsed.data.blocked_at,
      question_id: parsed.data.question_id,
      question: parsed.data.question,
      answered_at: answeredAt,
    });
  }
  return events.sort((left, right) =>
    left.blocked_at.localeCompare(right.blocked_at)
  );
}
