import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const claudeAuthModuleHref = pathToFileURL(
  path.join(__dirname, "..", "lib", "backends", "claude", "auth.js")
).href;

type ClaudeAuthModule = typeof import("../lib/backends/claude/auth.js");
type EnvKey =
  | "TEROK_CLAUDE_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "CLAUDE_API_KEY"
  | "TEROK_CLAUDE_OAUTH_ACCESS_TOKEN"
  | "CLAUDE_OAUTH_ACCESS_TOKEN"
  | "TEROK_CLAUDE_OAUTH_CACHE_MS";

const trackedEnvKeys: EnvKey[] = [
  "TEROK_CLAUDE_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "TEROK_CLAUDE_OAUTH_ACCESS_TOKEN",
  "CLAUDE_OAUTH_ACCESS_TOKEN",
  "TEROK_CLAUDE_OAUTH_CACHE_MS"
];

const originalEnv: Record<EnvKey, string | undefined> = Object.fromEntries(
  trackedEnvKeys.map((key) => [key, process.env[key]])
) as Record<EnvKey, string | undefined>;

let originalFetch: typeof globalThis.fetch;

test.beforeEach(() => {
  originalFetch = globalThis.fetch;
});

test.afterEach(() => {
  for (const key of trackedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  globalThis.fetch = originalFetch;
});

async function loadClaudeAuthModule(
  env: Partial<Record<EnvKey, string | null | undefined>> = {}
): Promise<ClaudeAuthModule> {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) {
      delete process.env[key as EnvKey];
    } else {
      process.env[key as EnvKey] = value;
    }
  }
  const href = `${claudeAuthModuleHref}?t=${randomUUID()}`;
  return import(href);
}

function mockFetch(
  response: { ok: boolean; status?: number; json?: unknown; text?: string } = {
    ok: true,
    json: { raw_key: "minted-api-key" }
  }
): void {
  globalThis.fetch = (async () => {
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 401),
      json: async () => response.json ?? {},
      text: async () => response.text ?? "error"
    };
  }) as unknown as typeof globalThis.fetch;
}

// Test API key precedence
test("getClaudeApiKey prefers TEROK_CLAUDE_API_KEY over other env vars", async () => {
  const { getClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: "terok-web-ui-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_API_KEY: "claude-key"
  });
  assert.equal(getClaudeApiKey(), "terok-web-ui-key");
});

test("getClaudeApiKey falls back to ANTHROPIC_API_KEY when TEROK_CLAUDE_API_KEY is missing", async () => {
  const { getClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_API_KEY: "claude-key"
  });
  assert.equal(getClaudeApiKey(), "anthropic-key");
});

test("getClaudeApiKey falls back to CLAUDE_API_KEY when other keys are missing", async () => {
  const { getClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    ANTHROPIC_API_KEY: null,
    CLAUDE_API_KEY: "claude-key"
  });
  assert.equal(getClaudeApiKey(), "claude-key");
});

test("getClaudeApiKey returns null when no API keys are present", async () => {
  const { getClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    ANTHROPIC_API_KEY: null,
    CLAUDE_API_KEY: null
  });
  assert.equal(getClaudeApiKey(), null);
});

// Test OAuth token extraction
test("resolveClaudeApiKey prefers API key over OAuth token", async () => {
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: "direct-api-key",
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token"
  });
  const result = await resolveClaudeApiKey();
  assert.equal(result, "direct-api-key");
});

test("resolveClaudeApiKey uses TEROK_CLAUDE_OAUTH_ACCESS_TOKEN for minting", async () => {
  mockFetch({ ok: true, json: { raw_key: "minted-key" } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    ANTHROPIC_API_KEY: null,
    CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token-1"
  });
  const result = await resolveClaudeApiKey();
  assert.equal(result, "minted-key");
});

test("resolveClaudeApiKey falls back to CLAUDE_OAUTH_ACCESS_TOKEN for minting", async () => {
  mockFetch({ ok: true, json: { raw_key: "minted-key-2" } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: null,
    CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token-2"
  });
  const result = await resolveClaudeApiKey();
  assert.equal(result, "minted-key-2");
});

test("resolveClaudeApiKey returns null when no credentials are available", async () => {
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    ANTHROPIC_API_KEY: null,
    CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: null,
    CLAUDE_OAUTH_ACCESS_TOKEN: null
  });
  const result = await resolveClaudeApiKey();
  assert.equal(result, null);
});

// Test cache reuse logic with various TTL scenarios
test("resolveClaudeApiKey reuses cached key within TTL", async () => {
  mockFetch({ ok: true, json: { raw_key: "cached-key" } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token",
    TEROK_CLAUDE_OAUTH_CACHE_MS: "300000" // 5 minutes
  });

  // First call should mint a new key
  const result1 = await resolveClaudeApiKey();
  assert.equal(result1, "cached-key");

  // Mock fetch to return a different key - should not be called
  mockFetch({ ok: true, json: { raw_key: "new-key" } });

  // Second call should reuse cached key
  const result2 = await resolveClaudeApiKey();
  assert.equal(result2, "cached-key");
});

test("resolveClaudeApiKey re-mints when cache expires", async () => {
  mockFetch({ ok: true, json: { raw_key: "first-key" } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token",
    TEROK_CLAUDE_OAUTH_CACHE_MS: "1" // 1ms TTL - very short
  });

  // First call
  const result1 = await resolveClaudeApiKey();
  assert.equal(result1, "first-key");

  // Wait for cache to expire
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Mock new response
  mockFetch({ ok: true, json: { raw_key: "second-key" } });

  // Second call should mint a new key
  const result2 = await resolveClaudeApiKey();
  assert.equal(result2, "second-key");
});

test("resolveClaudeApiKey re-mints when OAuth token changes", async () => {
  mockFetch({ ok: true, json: { raw_key: "first-token-key" } });
  let { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token-1",
    TEROK_CLAUDE_OAUTH_CACHE_MS: "300000"
  });

  const result1 = await resolveClaudeApiKey();
  assert.equal(result1, "first-token-key");

  // Reload module with different OAuth token
  mockFetch({ ok: true, json: { raw_key: "second-token-key" } });
  ({ resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token-2",
    TEROK_CLAUDE_OAUTH_CACHE_MS: "300000"
  }));

  const result2 = await resolveClaudeApiKey();
  assert.equal(result2, "second-token-key");
});

test("resolveClaudeApiKey handles invalid TTL by not caching", async () => {
  mockFetch({ ok: true, json: { raw_key: "key-1" } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token",
    TEROK_CLAUDE_OAUTH_CACHE_MS: "invalid"
  });

  await resolveClaudeApiKey();

  // Mock new response
  mockFetch({ ok: true, json: { raw_key: "key-2" } });

  // Should mint again because invalid TTL means no caching
  const result = await resolveClaudeApiKey();
  assert.equal(result, "key-2");
});

test("resolveClaudeApiKey handles zero TTL by not caching", async () => {
  mockFetch({ ok: true, json: { raw_key: "key-1" } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token",
    TEROK_CLAUDE_OAUTH_CACHE_MS: "0"
  });

  await resolveClaudeApiKey();

  // Mock new response
  mockFetch({ ok: true, json: { raw_key: "key-2" } });

  // Should mint again because zero TTL means no caching
  const result = await resolveClaudeApiKey();
  assert.equal(result, "key-2");
});

test("resolveClaudeApiKey handles negative TTL by not caching", async () => {
  mockFetch({ ok: true, json: { raw_key: "key-1" } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token",
    TEROK_CLAUDE_OAUTH_CACHE_MS: "-1000"
  });

  await resolveClaudeApiKey();

  // Mock new response
  mockFetch({ ok: true, json: { raw_key: "key-2" } });

  // Should mint again because negative TTL means no caching
  const result = await resolveClaudeApiKey();
  assert.equal(result, "key-2");
});

// Test error handling for failed OAuth requests
test("resolveClaudeApiKey throws on failed OAuth request", async () => {
  mockFetch({ ok: false, status: 401, text: "Unauthorized" });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "invalid-token"
  });

  await assert.rejects(
    async () => resolveClaudeApiKey(),
    /Claude OAuth request failed \(401\): Unauthorized/
  );
});

test("resolveClaudeApiKey throws when OAuth response is missing raw_key and api_key", async () => {
  mockFetch({ ok: true, json: {} });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token"
  });

  await assert.rejects(async () => resolveClaudeApiKey(), /Claude OAuth response missing API key/);
});

test("resolveClaudeApiKey accepts api_key field as fallback", async () => {
  mockFetch({ ok: true, json: { api_key: "fallback-key" } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token"
  });

  const result = await resolveClaudeApiKey();
  assert.equal(result, "fallback-key");
});

test("resolveClaudeApiKey prefers raw_key over api_key", async () => {
  mockFetch({ ok: true, json: { raw_key: "primary-key", api_key: "fallback-key" } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token"
  });

  const result = await resolveClaudeApiKey();
  assert.equal(result, "primary-key");
});

test("resolveClaudeApiKey throws when raw_key is empty string", async () => {
  mockFetch({ ok: true, json: { raw_key: "   " } });
  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token"
  });

  await assert.rejects(async () => resolveClaudeApiKey(), /Claude OAuth response missing API key/);
});

test("resolveClaudeApiKey returns null when fetch is unavailable", async () => {
  const savedFetch = globalThis.fetch;
  // @ts-expect-error - intentionally setting to undefined for test
  globalThis.fetch = undefined;

  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token"
  });

  const result = await resolveClaudeApiKey();
  assert.equal(result, null);

  globalThis.fetch = savedFetch;
});

// Test concurrent request handling via inflight request mechanism
test("resolveClaudeApiKey deduplicates concurrent requests", async () => {
  let fetchCallCount = 0;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    // Simulate delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      ok: true,
      status: 200,
      json: async () => ({ raw_key: "shared-key" }),
      text: async () => "ok"
    };
  }) as unknown as typeof globalThis.fetch;

  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token",
    TEROK_CLAUDE_OAUTH_CACHE_MS: "300000"
  });

  // Make 3 concurrent calls
  const [result1, result2, result3] = await Promise.all([
    resolveClaudeApiKey(),
    resolveClaudeApiKey(),
    resolveClaudeApiKey()
  ]);

  // All should get the same result
  assert.equal(result1, "shared-key");
  assert.equal(result2, "shared-key");
  assert.equal(result3, "shared-key");

  // Fetch should only be called once
  assert.equal(fetchCallCount, 1);
});

test("resolveClaudeApiKey allows new requests after inflight completes", async () => {
  let fetchCallCount = 0;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      ok: true,
      status: 200,
      json: async () => ({ raw_key: `key-${fetchCallCount}` }),
      text: async () => "ok"
    };
  }) as unknown as typeof globalThis.fetch;

  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token",
    TEROK_CLAUDE_OAUTH_CACHE_MS: "1" // Very short TTL
  });

  // First call
  const result1 = await resolveClaudeApiKey();
  assert.equal(result1, "key-1");

  // Wait for cache to expire
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Second call (should mint again)
  const result2 = await resolveClaudeApiKey();
  assert.equal(result2, "key-2");

  // Fetch should be called twice
  assert.equal(fetchCallCount, 2);
});

test("resolveClaudeApiKey clears inflight on error", async () => {
  let fetchCallCount = 0;
  globalThis.fetch = (async () => {
    fetchCallCount++;
    if (fetchCallCount === 1) {
      return {
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "Server error"
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ raw_key: "recovery-key" }),
      text: async () => "ok"
    };
  }) as unknown as typeof globalThis.fetch;

  const { resolveClaudeApiKey } = await loadClaudeAuthModule({
    TEROK_CLAUDE_API_KEY: null,
    TEROK_CLAUDE_OAUTH_ACCESS_TOKEN: "oauth-token"
  });

  // First call should fail
  await assert.rejects(async () => resolveClaudeApiKey(), /Claude OAuth request failed/);

  // Second call should succeed (inflight should be cleared)
  const result = await resolveClaudeApiKey();
  assert.equal(result, "recovery-key");
  assert.equal(fetchCallCount, 2);
});
