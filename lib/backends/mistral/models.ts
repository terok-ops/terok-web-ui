/**
 * Mistral backend model management.
 *
 * Uses the shared model manager with Mistral-specific configuration:
 * - Does not support reasoning effort levels
 * - Fetches models from Mistral API using API key
 * - Merges API models with models defined in Vibe CLI config
 * - Default model from environment, Vibe config, or falls back to mistral-large-latest
 */
import { getVibeConfig } from "../../vibeConfig.js";
import { createModelManager, type ModelManager } from "../modelManager.js";

interface ModelEntry {
  id?: string;
}

interface ModelResponse {
  data?: ModelEntry[];
}

/**
 * Vibe config is read once at module load time and cached for the application lifetime.
 * This is acceptable since the project runs in ephemeral containers with short lifespans.
 * Config changes require a container restart to take effect.
 */
const vibeConfig = getVibeConfig();

const DEFAULT_MISTRAL_MODEL =
  process.env.TEROK_MISTRAL_MODEL ||
  process.env.TEROK_MODEL ||
  vibeConfig?.active_model ||
  "mistral-large-latest";

function getMistralApiKey(): string | null {
  return process.env.TEROK_MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || null;
}

/**
 * Fetches available models from Mistral API.
 */
async function fetchModelsFromApi(): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;
  const apiKey = getMistralApiKey();
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeoutMs = Number(process.env.TEROK_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://api.mistral.ai/v1/models", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`Model request failed (${resp.status})`);
    }
    const payload = (await resp.json()) as ModelResponse;
    if (!payload || !Array.isArray(payload.data)) return null;

    const seen = new Set<string>();
    for (const entry of payload.data) {
      const id = typeof entry?.id === "string" ? entry.id : null;
      if (id) seen.add(id);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn("Failed to fetch Mistral models", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Singleton model manager instance with Vibe config model merging
const manager: ModelManager = createModelManager({
  defaultModel: DEFAULT_MISTRAL_MODEL || null,
  supportsEffort: false,
  defaultEffort: null,
  effortOptions: [],
  fetchModels: fetchModelsFromApi,
  configModels: vibeConfig?.models
});

export const getActiveModel = manager.getActiveModel;
export const updateModelSelection = manager.updateModelSelection;
export const getModelSettings = manager.getModelSettings;
