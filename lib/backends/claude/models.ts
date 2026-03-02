/**
 * Claude backend model management.
 *
 * Uses the shared model manager with Claude-specific configuration:
 * - Does not support reasoning effort levels
 * - Fetches models from Anthropic API using API key or OAuth token
 * - Default model from environment or falls back to claude-3-5-sonnet
 */
import { resolveClaudeApiKey } from "./auth.js";
import { createModelManager, type ModelManager } from "../modelManager.js";

interface ModelEntry {
  id?: string;
}

interface ModelResponse {
  data?: ModelEntry[];
}

const DEFAULT_CLAUDE_MODEL =
  process.env.TEROK_CLAUDE_MODEL || process.env.TEROK_MODEL || "claude-3-5-sonnet-20240620";

/**
 * Fetches available models from Anthropic API.
 * Requires valid API key (direct or minted from OAuth token).
 */
async function fetchModelsFromApi(): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;

  let apiKey: string | null = null;
  try {
    apiKey = await resolveClaudeApiKey();
  } catch (error) {
    console.warn("Failed to fetch Claude models", error instanceof Error ? error.message : error);
    return null;
  }
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeoutMs = Number(process.env.TEROK_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
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
    console.warn("Failed to fetch Claude models", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Singleton model manager instance
const manager: ModelManager = createModelManager({
  defaultModel: DEFAULT_CLAUDE_MODEL || null,
  supportsEffort: false,
  defaultEffort: null,
  effortOptions: [],
  fetchModels: fetchModelsFromApi
});

export const getActiveModel = manager.getActiveModel;
export const updateModelSelection = manager.updateModelSelection;
export const getModelSettings = manager.getModelSettings;
