import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const cliPath = path.join(process.cwd(), "dist", "index.js");

const runCli = async (args) => {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: process.cwd(),
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    return {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      exitCode: error.code ?? 1,
    };
  }
};

test("namespace help surfaces --help and global options", async () => {
  const result = await runCli(["documents", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Document commands\./);
  assert.match(result.stdout, /import/);
  assert.match(result.stdout, /Markdown/);
  assert.match(result.stdout, /--help/);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /--api-base-url <url>/);
});

test("comments namespace help lists the new subcommands", async () => {
  const result = await runCli(["comments", "--help"]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Comment commands\./);
  assert.match(result.stdout, /create/);
  assert.match(result.stdout, /reply/);
  assert.match(result.stdout, /resolve/);
});

test("top-level command typos suggest the nearest command", async () => {
  const result = await runCli(["documnts"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown command: documnts/);
  assert.match(result.stderr, /Did you mean `documents`\?/);
});

test("subcommand typos suggest the nearest scoped subcommand", async () => {
  const result = await runCli(["documents", "lst"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown subcommand: documents lst/);
  assert.match(result.stderr, /Did you mean `documents list`\?/);
});

test("unknown options suggest the nearest valid scoped flag", async () => {
  const result = await runCli(["documents", "list", "--limt", "5"]);

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown option `--limt` for `documents list`\./);
  assert.match(result.stderr, /Did you mean `--limit`\?/);
});
