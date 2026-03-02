import test from "node:test";
import assert from "node:assert/strict";

const originalBackend = process.env.TEROK_BACKEND;

test.afterEach(() => {
  if (originalBackend === undefined) {
    delete process.env.TEROK_BACKEND;
  } else {
    process.env.TEROK_BACKEND = originalBackend;
  }
});

test("getBackend selects the Codex adapter by default", async () => {
  delete process.env.TEROK_BACKEND;
  const { getBackend } = await import("../lib/backends/index.js");
  const backend = getBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });
  assert.equal(backend.name, "codex");
});

test("getBackend rejects unsupported backend ids", async () => {
  process.env.TEROK_BACKEND = "unsupported";
  const { getBackend } = await import("../lib/backends/index.js");
  assert.throws(() => {
    getBackend({
      workingDirectory: "/tmp",
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    });
  }, /Unsupported backend/);
});

test("getBackend selects the Claude adapter when configured", async () => {
  process.env.TEROK_BACKEND = "claude";
  const { getBackend } = await import("../lib/backends/index.js");
  const backend = getBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });
  assert.equal(backend.name, "claude");
});

test("Claude backend rejects runs without an API key", async () => {
  delete process.env.TEROK_CLAUDE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
  delete process.env.TEROK_CLAUDE_OAUTH_ACCESS_TOKEN;
  delete process.env.CLAUDE_OAUTH_ACCESS_TOKEN;
  const { createClaudeBackend } = await import("../lib/backends/claude/index.js");
  const backend = createClaudeBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });
  await assert.rejects(async () => backend.streamRun("hello"), /Missing Claude credentials/);
});

test("Claude backend rejects runs when network access is disabled", async () => {
  process.env.TEROK_CLAUDE_API_KEY = "test-key";
  const { createClaudeBackend } = await import("../lib/backends/claude/index.js");
  const backend = createClaudeBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: false,
    approvalPolicy: "never"
  });
  await assert.rejects(async () => backend.streamRun("hello"), /requires network access/);
});

test("getBackend selects the Mistral adapter when configured", async () => {
  process.env.TEROK_BACKEND = "mistral";
  const { getBackend } = await import("../lib/backends/index.js");
  const backend = getBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });
  assert.equal(backend.name, "mistral");
});

test("Mistral backend rejects runs without an API key", async () => {
  delete process.env.TEROK_MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  const { createMistralBackend } = await import("../lib/backends/mistral/index.js");
  const backend = createMistralBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });
  await assert.rejects(async () => backend.streamRun("hello"), /Missing Mistral API key/);
});

test("Mistral backend rejects runs when network access is disabled", async () => {
  process.env.TEROK_MISTRAL_API_KEY = "test-key";
  const { createMistralBackend } = await import("../lib/backends/mistral/index.js");
  const backend = createMistralBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: false,
    approvalPolicy: "never"
  });
  await assert.rejects(async () => backend.streamRun("hello"), /requires network access/);
});
