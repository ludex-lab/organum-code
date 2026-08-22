const RELEASE_TESTS = [
  "tests/release-archive.test.ts",
  "tests/release-cli.test.ts",
  "tests/release-installation.test.ts",
  "tests/release-manifest.test.ts",
  "tests/release-source-archive.test.ts",
  "tests/relink-materials.test.ts",
  "tests/runtime.test.ts",
  "tests/third-party-notices.test.ts",
] as const;

for (const file of RELEASE_TESTS) {
  console.log(`\n[release test] ${file}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["test", file], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(
        signal === null
          ? `Release test failed: ${file} (exit ${status ?? "unknown"})`
          : `Release test failed: ${file} (signal ${signal})`,
      ));
    });
  });
}

console.log(`\n${RELEASE_TESTS.length} release test files passed.`);
import { spawn } from "node:child_process";
