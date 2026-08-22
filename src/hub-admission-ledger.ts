import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { HubMemberBinding, HubReadTarget } from "./organum-cli.js";
import { parseCellIdentity } from "./organum-identity.js";

export const HUB_ADMISSION_LEDGER_PROTOCOL = 1;
const MAX_RECORD_BYTES = 4 * 1024;
const MAX_RECORDS_PER_BINDING = 1_024;

export interface DurableHubAdmission {
  target: HubReadTarget;
  admittedAt: string;
}

export interface HubAdmissionLedger {
  load(binding: HubMemberBinding): Promise<DurableHubAdmission[]>;
  record(
    binding: HubMemberBinding,
    target: HubReadTarget,
    admittedAt: string,
  ): Promise<void>;
  remove(binding: HubMemberBinding, target: HubReadTarget): Promise<void>;
}

export class HubAdmissionLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubAdmissionLedgerError";
  }
}

interface PersistedHubAdmission {
  protocol: 1;
  source: "home-hub";
  cell: string;
  epoch: string;
  event_id: string;
  file: string;
  admitted_at: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bindingDigest(binding: HubMemberBinding): string {
  return digest(`${binding.identity}\0${binding.epoch}`);
}

function eventFile(eventID: string): string {
  return `${digest(`home-hub\0${eventID}`)}.json`;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function nonemptyBounded(
  value: unknown,
  field: string,
  maxBytes = 256,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new HubAdmissionLedgerError(
      `Hub admission record ${field} is invalid`,
    );
  }
  return value;
}

function safeEnvelopeFile(value: unknown): string {
  const file = nonemptyBounded(value, "file", 512);
  if (
    !file.endsWith(".md") ||
    file.startsWith(".") ||
    file.includes("/") ||
    file.includes("\\")
  ) {
    throw new HubAdmissionLedgerError(
      "Hub admission record file is not a safe envelope name",
    );
  }
  return file;
}

function validateBinding(binding: HubMemberBinding): HubMemberBinding {
  const identity = parseCellIdentity(binding.identity);
  const epoch = nonemptyBounded(binding.epoch, "epoch");
  return { identity, epoch };
}

function validateTarget(
  binding: HubMemberBinding,
  target: HubReadTarget,
): HubReadTarget {
  const validatedBinding = validateBinding(binding);
  const toID = parseCellIdentity(target.to_id);
  const toEpoch = nonemptyBounded(target.to_epoch, "to_epoch");
  if (
    toID !== validatedBinding.identity ||
    toEpoch !== validatedBinding.epoch
  ) {
    throw new HubAdmissionLedgerError(
      "Hub admission target does not match its cell and epoch binding",
    );
  }
  return {
    file: safeEnvelopeFile(target.file),
    event_id: nonemptyBounded(target.event_id, "event_id"),
    to_id: toID,
    to_epoch: toEpoch,
  };
}

function sameTarget(left: HubReadTarget, right: HubReadTarget): boolean {
  return (
    left.file === right.file &&
    left.event_id === right.event_id &&
    left.to_id === right.to_id &&
    left.to_epoch === right.to_epoch
  );
}

function parseRecord(
  value: unknown,
  binding: HubMemberBinding,
  expectedName: string,
): DurableHubAdmission {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HubAdmissionLedgerError("Hub admission record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.protocol !== HUB_ADMISSION_LEDGER_PROTOCOL ||
    record.source !== "home-hub"
  ) {
    throw new HubAdmissionLedgerError(
      "Hub admission record protocol or source is invalid",
    );
  }
  const target = validateTarget(binding, {
    file: safeEnvelopeFile(record.file),
    event_id: nonemptyBounded(record.event_id, "event_id"),
    to_id: parseCellIdentity(nonemptyBounded(record.cell, "cell")),
    to_epoch: nonemptyBounded(record.epoch, "epoch"),
  });
  if (eventFile(target.event_id) !== expectedName) {
    throw new HubAdmissionLedgerError(
      "Hub admission record filename does not match its event ID",
    );
  }
  const admittedAt = nonemptyBounded(record.admitted_at, "admitted_at", 128);
  if (!Number.isFinite(Date.parse(admittedAt))) {
    throw new HubAdmissionLedgerError(
      "Hub admission record admitted_at is invalid",
    );
  }
  return { target, admittedAt };
}

export class FileHubAdmissionLedger implements HubAdmissionLedger {
  private readonly root: string;

  constructor(stateDirectory: string) {
    if (
      stateDirectory.trim().length === 0 ||
      stateDirectory.includes("\0") ||
      !isAbsolute(stateDirectory)
    ) {
      throw new HubAdmissionLedgerError(
        "Hub admission state directory must be a nonempty absolute path",
      );
    }
    this.root = join(resolve(stateDirectory), "hub-admissions-v1");
  }

  async load(binding: HubMemberBinding): Promise<DurableHubAdmission[]> {
    const directory = await this.bindingDirectory(binding);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_RECORDS_PER_BINDING * 2) {
      throw new HubAdmissionLedgerError(
        "Hub admission ledger directory contains too many entries",
      );
    }
    const records = entries
      .filter((entry) => entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (records.length > MAX_RECORDS_PER_BINDING) {
      throw new HubAdmissionLedgerError(
        `Hub admission ledger exceeds ${MAX_RECORDS_PER_BINDING} records for one binding`,
      );
    }
    const result: DurableHubAdmission[] = [];
    for (const entry of records) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new HubAdmissionLedgerError(
          `Hub admission record is not a regular file: ${entry.name}`,
        );
      }
      result.push(
        await this.readRecord(
          join(directory, entry.name),
          binding,
          entry.name,
        ),
      );
    }
    return result;
  }

  async record(
    binding: HubMemberBinding,
    target: HubReadTarget,
    admittedAt: string,
  ): Promise<void> {
    const validatedBinding = validateBinding(binding);
    const validatedTarget = validateTarget(validatedBinding, target);
    if (!Number.isFinite(Date.parse(admittedAt))) {
      throw new HubAdmissionLedgerError(
        "Hub admission timestamp must be a valid date-time",
      );
    }
    const directory = await this.bindingDirectory(validatedBinding);
    const name = eventFile(validatedTarget.event_id);
    const destination = join(directory, name);
    const existing = await this.readRecordIfPresent(
      destination,
      validatedBinding,
      name,
    );
    if (existing !== null) {
      if (!sameTarget(existing.target, validatedTarget)) {
        throw new HubAdmissionLedgerError(
          "Hub admission event ID conflicts with an existing durable target",
        );
      }
      return;
    }
    const record: PersistedHubAdmission = {
      protocol: HUB_ADMISSION_LEDGER_PROTOCOL,
      source: "home-hub",
      cell: validatedBinding.identity,
      epoch: validatedBinding.epoch,
      event_id: validatedTarget.event_id,
      file: validatedTarget.file,
      admitted_at: admittedAt,
    };
    const serialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_RECORD_BYTES) {
      throw new HubAdmissionLedgerError("Hub admission record is too large");
    }
    const temporary = join(
      directory,
      `${name}.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, destination);
    } catch (error) {
      const raced = await this.readRecordIfPresent(
        destination,
        validatedBinding,
        name,
      );
      if (raced === null || !sameTarget(raced.target, validatedTarget)) {
        throw error;
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    }
    const persisted = await this.readRecord(
      destination,
      validatedBinding,
      name,
    );
    if (!sameTarget(persisted.target, validatedTarget)) {
      throw new HubAdmissionLedgerError(
        "Hub admission record changed during atomic persistence",
      );
    }
  }

  async remove(
    binding: HubMemberBinding,
    target: HubReadTarget,
  ): Promise<void> {
    const validatedBinding = validateBinding(binding);
    const validatedTarget = validateTarget(validatedBinding, target);
    const directory = await this.bindingDirectory(validatedBinding);
    const name = eventFile(validatedTarget.event_id);
    const path = join(directory, name);
    const existing = await this.readRecordIfPresent(
      path,
      validatedBinding,
      name,
    );
    if (existing === null) return;
    if (!sameTarget(existing.target, validatedTarget)) {
      throw new HubAdmissionLedgerError(
        "Refusing to remove a conflicting hub admission record",
      );
    }
    await unlink(path);
  }

  private async bindingDirectory(binding: HubMemberBinding): Promise<string> {
    const validated = validateBinding(binding);
    const directory = join(this.root, bindingDigest(validated));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  private async readRecordIfPresent(
    path: string,
    binding: HubMemberBinding,
    expectedName: string,
  ): Promise<DurableHubAdmission | null> {
    try {
      return await this.readRecord(path, binding, expectedName);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async readRecord(
    path: string,
    binding: HubMemberBinding,
    expectedName: string,
  ): Promise<DurableHubAdmission> {
    const stats = await lstat(path);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size > MAX_RECORD_BYTES
    ) {
      throw new HubAdmissionLedgerError(
        "Hub admission record must be a bounded regular non-symlink file",
      );
    }
    const content = await readFile(path, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new HubAdmissionLedgerError("Hub admission record is invalid JSON");
    }
    return parseRecord(value, binding, expectedName);
  }
}
