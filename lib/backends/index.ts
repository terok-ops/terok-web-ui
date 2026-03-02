/**
 * Backend factory module.
 *
 * Implements the Strategy pattern for pluggable AI backends.
 * Each backend translates its provider's streaming API into a normalized
 * event stream (BackendEvent) that the server can render uniformly.
 *
 * Available backends:
 * - codex: OpenAI Codex SDK (default) - uses ChatGPT/OpenAI authentication
 * - claude: Anthropic Claude API - uses Claude CLI OAuth or API key
 * - mistral: Mistral AI API - uses Mistral API key
 *
 * Selection is via TEROK_BACKEND environment variable.
 */
import { createClaudeBackend } from "./claude/index.js";
import { createCodexBackend } from "./codex/index.js";
import { createMistralBackend } from "./mistral/index.js";
import type { Backend, BackendConfig } from "./types.js";

export type BackendId = "codex" | "claude" | "mistral";

/**
 * Create a backend instance based on TEROK_BACKEND environment variable.
 * Defaults to "codex" if not specified.
 *
 * @param config - Backend configuration (working directory, sandbox mode, etc.)
 * @returns Configured backend implementing the Backend interface
 * @throws Error if TEROK_BACKEND specifies an unknown backend
 */
export function getBackend(config: BackendConfig): Backend {
  const requested = (process.env.TEROK_BACKEND || "codex").toLowerCase();
  switch (requested) {
    case "codex":
      return createCodexBackend(config);
    case "claude":
      return createClaudeBackend(config);
    case "mistral":
      return createMistralBackend(config);
    default:
      throw new Error(`Unsupported backend: ${requested}`);
  }
}

export type {
  Backend,
  BackendConfig,
  BackendEvent,
  BackendModelSettings,
  ModelSelectionPayload
} from "./types.js";
