/**
 * Codex backend model management.
 *
 * Uses the shared model manager with Codex-specific configuration:
 * - Supports reasoning effort levels (minimal, low, medium, high, xhigh)
 * - Fetches models from ChatGPT backend API first, falls back to OpenAI API
 * - Reads defaults from environment and ~/.codex/config.toml
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  EFFORT_OPTIONS,
  type ReasoningEffort
} from "../../config.js";
import { getCodexAuth, getAccessToken } from "../../auth.js";
import { createModelManager, type ModelManager } from "../modelManager.js";

interface ModelEntry {
  id?: string;
}

interface ModelResponse {
  data?: ModelEntry[];
}

type CodexModelsResponse = {
  models?: Array<{ slug?: string; model?: string; id?: string }>;
};

const CHATGPT_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";

/**
 * Reads package.json version for ChatGPT API client_version parameter.
 * Falls back to "0.0.0" if package.json is missing or malformed.
 */
function getClientVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const packagePath = path.resolve(currentDir, "../../../package.json");
    const contents = fs.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(contents);
    if (typeof parsed?.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
  } catch {
    // Silently fall back - version is optional for API calls
  }
  return "0.0.0";
}

/**
 * Fetches models from ChatGPT backend using Codex CLI auth tokens.
 * This is the preferred source as it returns models the user actually has access to.
 */
async function fetchModelsFromChatgpt(): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;
  const { token, accountId } = getCodexAuth();
  if (!token) return null;

  const controller = new AbortController();
  const timeoutMs = Number(process.env.TEROK_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const clientVersion = getClientVersion();

  try {
    const url = new URL(CHATGPT_MODELS_ENDPOINT);
    if (clientVersion !== "0.0.0") {
      url.searchParams.set("client_version", clientVersion);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`
    };
    if (accountId) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`ChatGPT model request failed (${resp.status}) for ${url.toString()}`);
    }
    const payload = (await resp.json()) as CodexModelsResponse;
    if (!payload || !Array.isArray(payload.models)) return null;

    // Model entries may have slug, model, or id fields - prefer slug
    const seen = new Set<string>();
    for (const entry of payload.models) {
      const id =
        typeof entry?.slug === "string"
          ? entry.slug
          : typeof entry?.model === "string"
            ? entry.model
            : typeof entry?.id === "string"
              ? entry.id
              : null;
      if (id) seen.add(id);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn("Failed to fetch ChatGPT models", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fallback: fetches models from OpenAI API using API key.
 * Filters out fine-tuned (ft:) and deprecated models.
 */
async function fetchModelsFromApi(): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;
  const token = getAccessToken();
  if (!token) return null;

  const controller = new AbortController();
  const timeoutMs = Number(process.env.TEROK_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(OPENAI_MODELS_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
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
      if (!id) continue;
      if (id.startsWith("ft:")) continue; // Skip fine-tuned models
      if (id.includes("deprecated")) continue;
      seen.add(id);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn("Failed to fetch models", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Combined fetch strategy: try ChatGPT backend first, fall back to OpenAI API.
 */
async function fetchModels(): Promise<string[] | null> {
  return (await fetchModelsFromChatgpt()) || (await fetchModelsFromApi());
}

// Singleton model manager instance
const manager: ModelManager = createModelManager({
  defaultModel: DEFAULT_MODEL,
  supportsEffort: true,
  defaultEffort: DEFAULT_EFFORT,
  effortOptions: EFFORT_OPTIONS,
  fetchModels
});

export const getActiveModel = manager.getActiveModel;
export const updateModelSelection = manager.updateModelSelection;
export const getModelSettings = manager.getModelSettings;

// Re-export effort getter with proper typing for Codex SDK integration
export function getActiveEffort(): ReasoningEffort | null {
  return manager.getActiveEffort() as ReasoningEffort | null;
}

// For backwards compatibility with existing tests
export async function getAvailableModels(): Promise<string[]> {
  return (await manager.getModelSettings()).availableModels;
}
