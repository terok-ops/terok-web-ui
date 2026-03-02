import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const originalRepoRoot = process.env.REPO_ROOT;
const tempRepoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "terok-web-ui-repo-"));
process.env.REPO_ROOT = tempRepoRoot;

const { resolveRepoPath } = await import("../lib/config.js");

test.after(() => {
  process.env.REPO_ROOT = originalRepoRoot;
  fs.rmSync(tempRepoRoot, { recursive: true, force: true });
});

test("resolveRepoPath returns absolute and normalized relative paths", () => {
  const target = "nested/dir/file.txt";
  const resolved = resolveRepoPath(target);

  assert.equal(resolved.rel, "nested/dir/file.txt");
  assert.equal(resolved.abs, path.join(tempRepoRoot, "nested", "dir", "file.txt"));
});

test("resolveRepoPath rejects paths that escape the repository root", () => {
  assert.throws(() => resolveRepoPath("../outside.txt"), /Path escapes repository/);
  assert.throws(() => resolveRepoPath("nested/../../outside.txt"), /Path escapes repository/);
});
