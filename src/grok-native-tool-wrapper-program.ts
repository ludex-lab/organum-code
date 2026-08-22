/**
 * Self-contained program written into the isolated Grok runtime. Keeping the
 * runtime wrapper free of package-local imports lets the same exact command
 * work from source, tsc output, and a compiled Organum Code executable.
 */
export function grokNativeToolWrapperProgram(): string {
  return `import { spawn } from "node:child_process";
import { close, read } from "node:fs";

const FD = 9;
const MAX_CAPABILITY_BYTES = 128;
const MAX_RESPONSE_BYTES = 131072;
const ENDPOINT_ENV = "ORGANUM_CODE_GROK_TOOL_ENDPOINT";
const SESSION_ENV = "ORGANUM_CODE_GROK_TOOL_SESSION";
const TURN_ENV = "ORGANUM_CODE_GROK_TOOL_TURN";
const BROKER_ENV = "ORGANUM_CODE_BROKER_TOKEN";
const PATHNAME = "/grok-native-tool-wrapper";
const CONSUME_SCHEMA = "organum-code/grok-native-tool-consume/v1";
const EXECUTION_SCHEMA = "organum-code/grok-native-tool-execution/v1";
const CANONICALIZATION = "organum-code/rfc8785-json-arguments/v1";
const DIGEST_ALGORITHM = "sha-256";

function fail(kind) {
  throw new Error("organum_grok_wrapper:" + kind);
}

function boundedIdentity(name) {
  const value = process.env[name];
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    value.includes("\\0")
  ) fail("environment_invalid");
  return value;
}

function endpoint() {
  let value;
  try {
    value = new URL(process.env[ENDPOINT_ENV]);
  } catch {
    fail("endpoint_invalid");
  }
  if (
    value.protocol !== "http:" ||
    value.hostname !== "127.0.0.1" ||
    value.port.length === 0 ||
    value.pathname !== PATHNAME ||
    value.username.length > 0 ||
    value.password.length > 0 ||
    value.search.length > 0 ||
    value.hash.length > 0
  ) fail("endpoint_invalid");
  return value;
}

function readCapability() {
  return new Promise((resolve, reject) => {
    const buffer = Buffer.alloc(MAX_CAPABILITY_BYTES);
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("capability_unavailable")),
      2000,
    );
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      buffer.fill(0);
      close(FD, () => error ? reject(error) : resolve(value));
    }
    function next() {
      read(FD, buffer, bytes, MAX_CAPABILITY_BYTES - bytes, null, (error, count) => {
        if (settled) return;
        if (error || count === 0) {
          finish(new Error("capability_unavailable"));
          return;
        }
        bytes += count;
        if (buffer[bytes - 1] === 10) {
          const value = buffer.subarray(0, bytes - 1).toString("utf8");
          if (!/^occonsume-[0-9a-f]{64}$/.test(value)) {
            finish(new Error("capability_invalid"));
          } else {
            finish(null, value);
          }
          return;
        }
        if (bytes >= MAX_CAPABILITY_BYTES) {
          finish(new Error("capability_invalid"));
          return;
        }
        next();
      });
    }
    next();
  });
}

async function boundedJson(response) {
  if (response.body === null) fail("response_invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    bytes += result.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      fail("response_oversized");
    }
    chunks.push(result.value);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    fail("response_invalid");
  } finally {
    body.fill(0);
  }
}

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function validateExecution(value, sessionId, turnId) {
  if (!exactKeys(value, [
    "schema",
    "sessionId",
    "turnId",
    "nativeToolCallId",
    "nativeToolName",
    "effectClass",
    "argumentCanonicalization",
    "argumentDigestAlgorithm",
    "argumentBytes",
    "argumentSha256",
    "grantId",
    "command",
  ])) fail("response_invalid");
  if (
    value.schema !== EXECUTION_SCHEMA ||
    value.sessionId !== sessionId ||
    value.turnId !== turnId ||
    typeof value.nativeToolCallId !== "string" ||
    value.nativeToolCallId.length < 1 ||
    value.nativeToolCallId.length > 512 ||
    value.nativeToolCallId.includes("\\0") ||
    value.nativeToolName !== "run_terminal_command" ||
    value.effectClass !== "execute" ||
    value.argumentCanonicalization !== CANONICALIZATION ||
    value.argumentDigestAlgorithm !== DIGEST_ALGORITHM ||
    !Number.isSafeInteger(value.argumentBytes) ||
    value.argumentBytes < 0 ||
    !/^[0-9a-f]{64}$/.test(value.argumentSha256) ||
    !/^ocgrant-[0-9a-f]{32}$/.test(value.grantId) ||
    typeof value.command !== "string" ||
    value.command.length < 1 ||
    value.command.includes("\\0") ||
    Buffer.byteLength(value.command, "utf8") > 65536
  ) fail("response_invalid");
  return value.command;
}

function scrubbedEnvironment() {
  const env = { ...process.env };
  delete env[BROKER_ENV];
  delete env[ENDPOINT_ENV];
  delete env[SESSION_ENV];
  delete env[TURN_ENV];
  return env;
}

async function run() {
  if (process.argv.length !== 2) fail("arguments_invalid");
  const target = endpoint();
  const sessionId = boundedIdentity(SESSION_ENV);
  const turnId = boundedIdentity(TURN_ENV);
  let capability;
  try {
    capability = await readCapability();
  } catch (error) {
    fail(error instanceof Error && error.message === "capability_invalid"
      ? "capability_invalid"
      : "capability_unavailable");
  }
  let response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema: CONSUME_SCHEMA,
        sessionId,
        turnId,
        consumeCapability: capability,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    fail("transport_failed");
  } finally {
    capability = "";
  }
  if (response.status !== 200) fail("supervisor_status");
  if (!/^application\\/json(?:;|$)/i.test(response.headers.get("content-type") || "")) {
    fail("response_invalid");
  }
  const command = validateExecution(
    await boundedJson(response),
    sessionId,
    turnId,
  );
  const child = spawn(
    process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
    process.platform === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-c", command],
    {
      cwd: process.cwd(),
      env: scrubbedEnvironment(),
      stdio: "inherit",
    },
  );
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(code !== null ? code : signal === null ? 1 : 128);
    });
  });
}

try {
  process.exitCode = await run();
} catch (error) {
  const match = /^organum_grok_wrapper:([a-z_]+)$/.exec(
    error instanceof Error ? error.message : "",
  );
  process.stderr.write(
    "organum_grok_wrapper_error:" + (match?.[1] || "response_invalid") + "\\n",
  );
  process.exitCode = 74;
}
`;
}
