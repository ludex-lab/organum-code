export const MACOS_PTY_BRIDGE = String.raw`
import errno
import fcntl
import json
import os
import pty
import select
import struct
import stat
import subprocess
import sys
import termios
import time
import hashlib
import re

HEAD_LIMIT = 1024 * 1024
TAIL_LIMIT = 1024 * 1024
COMPACTION_MARKER = b"\r\n[organum-code: PTY output compacted; bounded tail follows]\r\n"
HUMAN_INPUT_REQUEST_SCHEMA = "organum-code/human-input-request/v1"
HUMAN_INPUT_RESPONSE_SCHEMA = "organum-code/human-input-response/v1"
HUMAN_INPUT_RECEIPT_SCHEMA = "organum-code/human-input-receipt/v1"
ANSI_ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\\\))")

head_written = 0
tail = bytearray()
source_bytes = 0
screen_tail = bytearray()

def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]

def capture(data):
    global head_written, source_bytes
    source_bytes += len(data)
    screen_tail.extend(data)
    if len(screen_tail) > 65536:
        del screen_tail[:-65536]
    remaining = max(0, HEAD_LIMIT - head_written)
    if remaining:
        prefix = data[:remaining]
        write_all(sys.stdout.fileno(), prefix)
        head_written += len(prefix)
        data = data[remaining:]
    if data:
        tail.extend(data)
        if len(tail) > TAIL_LIMIT:
            del tail[:-TAIL_LIMIT]

completion_receipt_path = sys.argv[1] or None
human_request_directory = sys.argv[2] or None
human_response_directory = sys.argv[3] or None
human_receipt_directory = sys.argv[4] or None
human_run_id = sys.argv[5] or None
human_lane_id = sys.argv[6] or None
human_backend = sys.argv[7] or None
command = sys.argv[8:]
completion_stage = 0
completion_deadline = None
completion_telemetry_emitted = False
active_question_id = None
observed_questions = set()

def completion_received():
    if completion_receipt_path is None:
        return None
    try:
        with open(completion_receipt_path, "r", encoding="utf-8") as receipt:
            value = json.load(receipt)
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    status = value.get("status") if isinstance(value, dict) else None
    return status if status in ("completed", "failed") else None

def iso_now():
    wall = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(wall)) + (
        ".%03dZ" % int((wall % 1) * 1000)
    )

def atomic_json(path, value):
    temporary = "%s.%s.tmp" % (path, os.getpid())
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        body = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        write_all(descriptor, body)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)

def normalized_question():
    text = ANSI_ESCAPE.sub("", bytes(screen_tail).decode("utf-8", errors="replace"))
    waiting = text.rfind("Waiting for user input")
    asking = text.rfind("AskUserQuestion", 0, waiting if waiting >= 0 else len(text))
    if asking < 0 or waiting < asking:
        return None
    value = text[asking:waiting].strip()
    value = "\n".join(line.rstrip() for line in value.splitlines()).strip()
    if not value:
        return None
    return value[-8192:]

def detect_human_input():
    global active_question_id
    if human_request_directory is None or active_question_id is not None:
        return
    question = normalized_question()
    if question is None:
        return
    question_id = hashlib.sha256(question.encode("utf-8")).hexdigest()
    if question_id in observed_questions:
        return
    observed_questions.add(question_id)
    active_question_id = question_id
    request = {
        "schema": HUMAN_INPUT_REQUEST_SCHEMA,
        "run_id": human_run_id,
        "lane_id": human_lane_id,
        "backend": human_backend,
        "state": "blocked_on_human_input",
        "blocked_at": iso_now(),
        "question_id": question_id,
        "question": question,
    }
    atomic_json(os.path.join(human_request_directory, question_id + ".json"), request)
    print(
        "[organum-code:human-input] " + json.dumps(
            {
                "schema": HUMAN_INPUT_REQUEST_SCHEMA,
                "state": "blocked_on_human_input",
                "question_id": question_id,
                "blocked_at": request["blocked_at"],
            },
            separators=(",", ":"),
        ),
        file=sys.stderr,
        flush=True,
    )

def bounded_regular_json(path):
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except (FileNotFoundError, OSError):
        return None
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 16384:
            return None
        body = os.read(descriptor, 16385)
    finally:
        os.close(descriptor)
    if len(body) > 16384:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None

def accept_human_response():
    global active_question_id
    if (
        active_question_id is None
        or human_response_directory is None
        or human_receipt_directory is None
    ):
        return
    response = bounded_regular_json(
        os.path.join(human_response_directory, active_question_id + ".json")
    )
    if not isinstance(response, dict) or set(response) != {"schema", "question_id", "answer"}:
        return
    if response.get("schema") != HUMAN_INPUT_RESPONSE_SCHEMA:
        return
    if response.get("question_id") != active_question_id:
        return
    answer = response.get("answer")
    if not isinstance(answer, str) or not answer or len(answer.encode("utf-8")) > 8192 or "\x00" in answer:
        return
    try:
        os.write(master, answer.encode("utf-8") + b"\n")
    except OSError as error:
        if error.errno in (errno.EIO, errno.EPIPE):
            return
        raise
    answered_at = iso_now()
    atomic_json(
        os.path.join(human_receipt_directory, active_question_id + ".json"),
        {
            "schema": HUMAN_INPUT_RECEIPT_SCHEMA,
            "question_id": active_question_id,
            "status": "answered",
            "answered_at": answered_at,
        },
    )
    print(
        "[organum-code:human-input] " + json.dumps(
            {
                "schema": HUMAN_INPUT_RECEIPT_SCHEMA,
                "state": "answered",
                "question_id": active_question_id,
                "answered_at": answered_at,
            },
            separators=(",", ":"),
        ),
        file=sys.stderr,
        flush=True,
    )
    active_question_id = None

def write_eot():
    try:
        os.write(master, b"\x04")
    except OSError as error:
        if error.errno not in (errno.EIO, errno.EPIPE):
            raise

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
child = subprocess.Popen(
    command,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)
stdin_open = True
master_open = True
while master_open:
    now = time.monotonic()
    completion_status = completion_received() if completion_stage == 0 else None
    if completion_stage == 0 and completion_status is not None:
        completion_stage = 1
        completion_deadline = now + 0.25
        if not completion_telemetry_emitted:
            completion_telemetry_emitted = True
            print(
                "[organum-code:pty-completion-receipt] " + json.dumps(
                    {
                        "schema": "organum-code/pty-completion-receipt/v1",
                        "status": completion_status,
                        "observed_at": iso_now(),
                    },
                    separators=(",", ":"),
                ),
                file=sys.stderr,
                flush=True,
            )
    elif completion_stage == 1 and now >= completion_deadline:
        write_eot()
        completion_stage = 2
        completion_deadline = now + 0.10
    elif completion_stage == 2 and now >= completion_deadline:
        write_eot()
        completion_stage = 3
        completion_deadline = None
    readers = [master]
    if stdin_open:
        readers.append(sys.stdin.fileno())
    ready, _, _ = select.select(readers, [], [], 0.05)
    if sys.stdin.fileno() in ready:
        data = os.read(sys.stdin.fileno(), 65536)
        if data:
            os.write(master, data)
        else:
            stdin_open = False
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            data = b""
        if data:
            capture(data)
            detect_human_input()
        else:
            master_open = False
    accept_human_response()
    if child.poll() is not None and master not in ready:
        try:
            data = os.read(master, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            data = b""
        if data:
            capture(data)
        else:
            master_open = False
os.close(master)
discarded_bytes = max(0, source_bytes - head_written - len(tail))
compacted = discarded_bytes > 0
if tail:
    if compacted:
        write_all(sys.stdout.fileno(), COMPACTION_MARKER)
    write_all(sys.stdout.fileno(), tail)
print(
    "[organum-code:pty-compaction] " + json.dumps(
        {
            "schema": "organum-code/pty-compaction/v1",
            "compacted": compacted,
            "discarded_bytes": discarded_bytes,
            "source_bytes": source_bytes,
            "emitted_bytes": head_written + len(tail),
        },
        separators=(",", ":"),
    ),
    file=sys.stderr,
    flush=True,
)
code = child.wait()
raise SystemExit(code if code >= 0 else 128 - code)
`;

export interface PtyBridgeCompactionTelemetry {
  compacted: boolean;
  discardedBytes: number;
  sourceBytes: number;
  emittedBytes: number;
}

export interface PtyBridgeCompletionReceiptTelemetry {
  status: "completed" | "failed";
  observedAt: string;
}

const PTY_COMPACTION_TELEMETRY_PREFIX =
  "[organum-code:pty-compaction] ";
const PTY_COMPLETION_RECEIPT_TELEMETRY_PREFIX =
  "[organum-code:pty-completion-receipt] ";

export function parsePtyBridgeCompactionTelemetry(
  output: string | Buffer,
): PtyBridgeCompactionTelemetry | null {
  const text = typeof output === "string"
    ? output
    : output.toString("utf8");
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.startsWith(PTY_COMPACTION_TELEMETRY_PREFIX)) continue;
    try {
      const record = JSON.parse(
        line.slice(PTY_COMPACTION_TELEMETRY_PREFIX.length),
      ) as Record<string, unknown>;
      if (
        record.schema !== "organum-code/pty-compaction/v1" ||
        typeof record.compacted !== "boolean" ||
        !Number.isSafeInteger(record.discarded_bytes) ||
        (record.discarded_bytes as number) < 0 ||
        !Number.isSafeInteger(record.source_bytes) ||
        (record.source_bytes as number) < 0 ||
        !Number.isSafeInteger(record.emitted_bytes) ||
        (record.emitted_bytes as number) < 0 ||
        record.compacted !== ((record.discarded_bytes as number) > 0) ||
        (record.emitted_bytes as number) +
            (record.discarded_bytes as number) !==
          record.source_bytes
      ) {
        continue;
      }
      return {
        compacted: record.compacted,
        discardedBytes: record.discarded_bytes as number,
        sourceBytes: record.source_bytes as number,
        emittedBytes: record.emitted_bytes as number,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function parsePtyBridgeCompletionReceiptTelemetry(
  output: string | Buffer,
): PtyBridgeCompletionReceiptTelemetry | null {
  const text = typeof output === "string"
    ? output
    : output.toString("utf8");
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.startsWith(PTY_COMPLETION_RECEIPT_TELEMETRY_PREFIX)) continue;
    try {
      const record = JSON.parse(
        line.slice(PTY_COMPLETION_RECEIPT_TELEMETRY_PREFIX.length),
      ) as Record<string, unknown>;
      if (
        record.schema !== "organum-code/pty-completion-receipt/v1" ||
        (record.status !== "completed" && record.status !== "failed") ||
        typeof record.observed_at !== "string" ||
        !Number.isFinite(Date.parse(record.observed_at))
      ) {
        continue;
      }
      return {
        status: record.status,
        observedAt: record.observed_at,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export interface PtyBridgeCommand {
  executable: "/usr/bin/python3";
  args: readonly string[];
}

export interface PtyBridgeOptions {
  /**
   * A supervisor-owned completion receipt. Once it contains a terminal
   * Deep Code status, the bridge gives the TUI a bounded grace period and
   * injects EOT twice through the PTY master.
   */
  completionReceiptPath?: string;
  humanInput?: {
    requestDirectory: string;
    responseDirectory: string;
    receiptDirectory: string;
    runID: string;
    laneID: string;
    backend: string;
  };
}

export function prepareMacosPtyBridge(
  executable: string,
  args: readonly string[],
  options: PtyBridgeOptions = {},
): PtyBridgeCommand {
  if (process.platform !== "darwin") {
    throw new Error("Bounded PTY automation is implemented on macOS only");
  }
  return {
    executable: "/usr/bin/python3",
    args: [
      "-c",
      MACOS_PTY_BRIDGE,
      options.completionReceiptPath ?? "",
      options.humanInput?.requestDirectory ?? "",
      options.humanInput?.responseDirectory ?? "",
      options.humanInput?.receiptDirectory ?? "",
      options.humanInput?.runID ?? "",
      options.humanInput?.laneID ?? "",
      options.humanInput?.backend ?? "",
      executable,
      ...args,
    ],
  };
}
