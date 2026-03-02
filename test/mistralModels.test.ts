import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { REPO_ROOT_ABS } from "../lib/config.js";
import { clearVibeConfigCache } from "../lib/vibeConfig.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mistralModuleHref = pathToFileURL(
  path.join(__dirname, "..", "lib", "backends", "mistral", "models.js")
).href;

const originalFetch = global.fetch;
const trackedEnvKeys = ["TEROK_MISTRAL_MODEL"] as const;
type EnvKey = (typeof trackedEnvKeys)[number];
const originalEnv: Record<EnvKey, string | undefined> = Object.fromEntries(
  trackedEnvKeys.map((key) => [key, process.env[key]])
) as Record<EnvKey, string | undefined>;

const repoConfigPath = path.join(REPO_ROOT_ABS, ".vibe", "config.toml");
const userConfigPath = path.join(os.homedir(), ".vibe", "config.toml");

type Backup = {
  existed: boolean;
  contents: string | null;
};

function backupFile(filePath: string): Backup {
  if (!fs.existsSync(filePath)) {
    return { existed: false, contents: null };
  }
  return { existed: true, contents: fs.readFileSync(filePath, "utf8") };
}

function restoreFile(filePath: string, backup: Backup): void {
  if (backup.existed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, backup.contents ?? "", "utf8");
    return;
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

// NOTE: Dynamic import with random query parameter is used to work around module-level
// caching of vibeConfig. Each test needs a fresh module instance to ensure the config
// is re-read based on the test's file system state. This is necessary because the
// implementation reads vibeConfig at module load time for performance in production.
async function loadMistralModelsModule() {
  const href = `${mistralModuleHref}?t=${randomUUID()}`;
  return import(href);
}

test.beforeEach(() => {
  for (const key of trackedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  global.fetch = undefined as unknown as typeof fetch;
  clearVibeConfigCache();
});

test.afterEach(() => {
  for (const key of trackedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  global.fetch = originalFetch;
  clearVibeConfigCache();
});

test("Mistral models use vibe config defaults when present", async () => {
  const repoBackup = backupFile(repoConfigPath);
  const userBackup = backupFile(userConfigPath);

  try {
    ensureDir(repoConfigPath);
    fs.writeFileSync(
      repoConfigPath,
      ['active_model = "vibe-model"', 'models = ["vibe-only"]', ""].join("\n"),
      "utf8"
    );

    const { getModelSettings } = await loadMistralModelsModule();
    const settings = await getModelSettings();

    assert.equal(settings.defaultModel, "vibe-model");
    assert.equal(settings.model, "vibe-model");
    assert.deepEqual(settings.availableModels, ["vibe-only"]);
  } finally {
    restoreFile(repoConfigPath, repoBackup);
    restoreFile(userConfigPath, userBackup);
  }
});

test("Mistral models fall back to env defaults without vibe config", async () => {
  const repoBackup = backupFile(repoConfigPath);
  const userBackup = backupFile(userConfigPath);

  try {
    restoreFile(repoConfigPath, { existed: false, contents: null });
    restoreFile(userConfigPath, { existed: false, contents: null });

    process.env.TEROK_MISTRAL_MODEL = "env-model";

    const { getModelSettings } = await loadMistralModelsModule();
    const settings = await getModelSettings();

    assert.equal(settings.defaultModel, "env-model");
    assert.deepEqual(settings.availableModels, []);
  } finally {
    restoreFile(repoConfigPath, repoBackup);
    restoreFile(userConfigPath, userBackup);
  }
});
