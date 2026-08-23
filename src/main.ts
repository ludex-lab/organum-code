#!/usr/bin/env node

import { main } from "./cli.js";
import {
  readBoundedClaudeHookInput,
  runClaudeNativeToolHook,
} from "./claude-native-tool-hook.js";
import { ConfigurationError } from "./provider-profile.js";
import {
  assertSupportedBunConsumerRuntime,
  currentBunVersion,
} from "./runtime.js";

async function run(): Promise<number> {
  assertSupportedBunConsumerRuntime(currentBunVersion());
  if (process.argv[2] === "__claude-native-tool-hook") {
    const endpoint = process.argv[3];
    const timeout = process.argv[4];
    if (
      endpoint === undefined ||
      timeout === undefined ||
      !/^[1-9][0-9]{0,4}$/.test(timeout)
    ) {
      console.error("organum_claude_hook_error:input_invalid");
      return 2;
    }
    let input: unknown;
    try {
      input = await readBoundedClaudeHookInput(process.stdin);
    } catch (error) {
      const kind =
        typeof error === "object" &&
          error !== null &&
          "kind" in error &&
          typeof error.kind === "string"
          ? error.kind
          : "input_invalid";
      console.error(`organum_claude_hook_error:${kind}`);
      return 2;
    }
    const result = await runClaudeNativeToolHook({
      endpoint,
      input,
      timeoutMs: Number(timeout),
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.exitCode;
  }
  return main();
}

run().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ConfigurationError) {
      console.error(`Configuration error: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(`organum-code: ${error.message}`);
    } else {
      console.error("organum-code: unknown error");
    }
    process.exitCode = 1;
  },
);
