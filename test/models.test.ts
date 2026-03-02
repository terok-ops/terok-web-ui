import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modelsModuleHref = pathToFileURL(
  path.join(__dirname, "..", "lib", "backends", "codex", "models.js")
).href;

const originalFetch = global.fetch;
const originalReadFileSync = fs.readFileSync;
const trackedEnvKeys = ["OPENAI_API_KEY", "TEROK_MODEL_CACHE_MS", "CODEX_AUTH"] as const;
type EnvKey = (typeof trackedEnvKeys)[number];
const originalEnv: Record<EnvKey, string | undefined> = Object.fromEntries(
  trackedEnvKeys.map((key) => [key, process.env[key]])
) as Record<EnvKey, string | undefined>;
test.afterEach(() => {
  for (const key of trackedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  global.fetch = originalFetch;
  fs.readFileSync = originalReadFileSync;
});

type FetchImpl = typeof fetch | null | undefined;
type ModelsModule = typeof import("../lib/backends/codex/models.js");

function mockAuthFile(contents: string): void {
  fs.readFileSync = (() => contents) as unknown as typeof fs.readFileSync;
}

function mockAuthFileFailure(): void {
  fs.readFileSync = (() => {
    throw new Error("missing auth file");
  }) as unknown as typeof fs.readFileSync;
}

async function loadModelsModule({
  apiKey,
  fetchImpl,
  cacheMs,
  authPath
}: Record<string, unknown> = {}): Promise<ModelsModule> {
  applyEnvOverride("OPENAI_API_KEY", apiKey as string | null | undefined);
  applyEnvOverride("TEROK_MODEL_CACHE_MS", cacheMs as string | number | null | undefined);
  applyEnvOverride("CODEX_AUTH", authPath as string | null | undefined);
  if (fetchImpl === undefined) {
    global.fetch = originalFetch as typeof fetch;
  } else if (fetchImpl === null) {
    global.fetch = undefined as unknown as typeof fetch;
  } else {
    global.fetch = fetchImpl as typeof fetch;
  }
  const href = `${modelsModuleHref}?t=${randomUUID()}`;
  return import(href);
}

function applyEnvOverride(key: EnvKey, value: string | number | null | undefined): void {
  if (value === undefined || value === null) {
    delete process.env[key];
  } else {
    process.env[key] = String(value);
  }
}

test("getAvailableModels returns remote data and caches calls", async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          data: [{ id: "gpt-zeta" }, { id: "ft:skip-me" }, { id: "o4" }, { id: "deprecated-model" }]
        };
      }
    };
  };
  const { getAvailableModels } = await loadModelsModule({ apiKey: "token", fetchImpl: mockFetch });
  const first = await getAvailableModels();
  const second = await getAvailableModels();
  assert.equal(callCount, 1, "remote fetch should run only once due to caching");
  assert.deepEqual(first, second, "cached result should be reused");
  assert.ok(first.includes("gpt-zeta"), "new remote models should be included");
  assert.ok(!first.includes("ft:skip-me"), "fine-tune models should be filtered out");
  assert.ok(!first.includes("deprecated-model"), "deprecated models should be filtered out");
});

test("updateModelSelection normalizes values and records manual effort overrides", async () => {
  const { updateModelSelection, getModelSettings } = await loadModelsModule({ fetchImpl: null });

  updateModelSelection({ model: "  custom-model  " });
  let settings = await getModelSettings();
  assert.equal(settings.model, "custom-model", "model names should be trimmed");

  updateModelSelection({ effort: "HIGH" });
  settings = await getModelSettings();
  assert.equal(settings.effort, "high", "effort should be normalized");

  updateModelSelection({ model: "", effort: "ultra" });
  settings = await getModelSettings();
  assert.equal(settings.model, null, "empty strings clear the manual model override");
  assert.equal(settings.effort, "high", "invalid effort leaves the previous value untouched");

  updateModelSelection({ model: null, effort: "" });
  settings = await getModelSettings();
  assert.equal(settings.model, null, "explicit null resets the manual model");
  assert.equal(settings.effort, null, "empty strings clear manual effort overrides");
  assert.ok(Array.isArray(settings.availableModels), "model settings should expose an array");
});

test("getAvailableModels returns an empty list when remote fetch is unavailable", async () => {
  const { getAvailableModels } = await loadModelsModule({ apiKey: null, fetchImpl: null });
  const models = await getAvailableModels();
  assert.deepEqual(models, [], "should return an empty list when fetch cannot run");
});

test("getAvailableModels coalesces concurrent fetches", async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ id: "gpt-concurrent" }] };
      }
    };
  };
  const { getAvailableModels } = await loadModelsModule({ apiKey: "token", fetchImpl: mockFetch });
  const [first, second] = await Promise.all([getAvailableModels(), getAvailableModels()]);
  assert.equal(callCount, 1, "inflight fetch should be shared across callers");
  assert.deepEqual(first, second, "concurrent callers should receive identical lists");
  assert.ok(
    first.includes("gpt-concurrent"),
    "remote models should still be included in the response"
  );
});

test("fetchModelsFromChatgpt uses Codex CLI auth and returns ChatGPT backend models", async () => {
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  const mockFetch = async (url: string, options?: { headers?: Record<string, string> }) => {
    capturedUrl = url;
    capturedHeaders = options?.headers || {};
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          models: [
            { slug: "gpt-chatgpt-1" },
            { model: "gpt-chatgpt-2" },
            { id: "gpt-chatgpt-3" },
            { slug: "gpt-chatgpt-4", model: "gpt-chatgpt-4-model" }
          ]
        };
      }
    };
  };
  mockAuthFile(JSON.stringify({ tokens: { access_token: "codex-token" } }));
  const { getAvailableModels } = await loadModelsModule({
    apiKey: null,
    fetchImpl: mockFetch,
    authPath: "/tmp/codex-auth.json"
  });
  const models = await getAvailableModels();
  assert.ok(capturedUrl.startsWith("https://chatgpt.com/backend-api/codex/models"));
  assert.equal(capturedHeaders.Authorization, "Bearer codex-token");
  assert.ok(models.includes("gpt-chatgpt-1"), "should include slug field");
  assert.ok(models.includes("gpt-chatgpt-2"), "should include model field");
  assert.ok(models.includes("gpt-chatgpt-3"), "should include id field");
  assert.ok(models.includes("gpt-chatgpt-4"), "should prefer slug over model field");
});

test("fetchModelsFromChatgpt includes ChatGPT-Account-ID header when account_id is present", async () => {
  let capturedHeaders: Record<string, string> = {};
  const mockFetch = async (_url: string, options?: { headers?: Record<string, string> }) => {
    capturedHeaders = options?.headers || {};
    return {
      ok: true,
      status: 200,
      async json() {
        return { models: [{ id: "test-model" }] };
      }
    };
  };
  mockAuthFile(JSON.stringify({ tokens: { access_token: "token" }, account_id: "acc-123" }));
  const { getAvailableModels } = await loadModelsModule({
    apiKey: null,
    fetchImpl: mockFetch,
    authPath: "/tmp/codex-auth.json"
  });
  await getAvailableModels();
  assert.equal(capturedHeaders["ChatGPT-Account-ID"], "acc-123");
});

test("fetchModelsFromChatgpt omits ChatGPT-Account-ID header when account_id is missing", async () => {
  let capturedHeaders: Record<string, string> = {};
  const mockFetch = async (_url: string, options?: { headers?: Record<string, string> }) => {
    capturedHeaders = options?.headers || {};
    return {
      ok: true,
      status: 200,
      async json() {
        return { models: [{ id: "test-model" }] };
      }
    };
  };
  mockAuthFile(JSON.stringify({ tokens: { access_token: "token" } }));
  const { getAvailableModels } = await loadModelsModule({
    apiKey: null,
    fetchImpl: mockFetch,
    authPath: "/tmp/codex-auth.json"
  });
  await getAvailableModels();
  assert.ok(!("ChatGPT-Account-ID" in capturedHeaders));
});

test("fetchModelsFromChatgpt falls back to OpenAI API when auth file is missing", async () => {
  let chatgptCalled = false;
  let openaiCalled = false;
  const mockFetch = async (url: string) => {
    if (url.includes("chatgpt.com")) {
      chatgptCalled = true;
    } else if (url.includes("api.openai.com")) {
      openaiCalled = true;
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ id: "fallback-model" }] };
      }
    };
  };
  mockAuthFileFailure();
  const { getAvailableModels } = await loadModelsModule({
    apiKey: "openai-key",
    fetchImpl: mockFetch,
    authPath: "/tmp/missing-auth.json"
  });
  const models = await getAvailableModels();
  assert.ok(!chatgptCalled, "should not call ChatGPT backend when auth is missing");
  assert.ok(openaiCalled, "should fall back to OpenAI API");
  assert.ok(models.includes("fallback-model"));
});

test("fetchModelsFromChatgpt handles error responses gracefully", async () => {
  const mockFetch = async (url: string) => {
    if (url.includes("chatgpt.com")) {
      return {
        ok: false,
        status: 401,
        async json() {
          return {};
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [] };
      }
    };
  };
  mockAuthFile(JSON.stringify({ tokens: { access_token: "bad-token" } }));
  const { getAvailableModels } = await loadModelsModule({
    apiKey: "openai-key",
    fetchImpl: mockFetch,
    authPath: "/tmp/codex-auth.json"
  });
  const models = await getAvailableModels();
  assert.deepEqual(models, [], "should return empty list when both backends fail");
});

test("fetchModelsFromApi uses auth file when environment variables are absent", async () => {
  let capturedAuth = "";
  const mockFetch = async (_url: string, options?: { headers?: Record<string, string> }) => {
    capturedAuth = options?.headers?.Authorization || "";
    return {
      ok: true,
      status: 200,
      async json() {
        return { data: [{ id: "api-model" }] };
      }
    };
  };
  mockAuthFile(JSON.stringify({ OPENAI_API_KEY: "file-api-key" }));
  const { getAvailableModels } = await loadModelsModule({
    apiKey: null,
    fetchImpl: mockFetch,
    authPath: "/tmp/codex-auth.json"
  });
  const models = await getAvailableModels();
  assert.equal(capturedAuth, "Bearer file-api-key");
  assert.ok(models.includes("api-model"));
});
