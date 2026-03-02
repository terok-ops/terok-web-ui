/**
 * Global configuration for the Terok Web UI server.
 *
 * Configuration sources (in priority order):
 * 1. Environment variables (highest priority)
 * 2. ~/.codex/config.toml (for model/effort defaults)
 * 3. Hardcoded defaults (lowest priority)
 *
 * The server runs in an isolated container with /workspace as the default
 * working directory. All paths are resolved relative to REPO_ROOT.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Root directory for repository operations. Container typically mounts code here. */
export const REPO_ROOT: string = process.env.REPO_ROOT || "/workspace";
/** Host to bind the HTTP server to. "0.0.0.0" allows external container access. */
export const HOST: string = process.env.HOST || "0.0.0.0";
/** Port for the HTTP server. 7860 is Hugging Face Spaces default. */
export const PORT: number = Number(process.env.PORT || 7860);
/** Absolute path to REPO_ROOT for path resolution. */
export const REPO_ROOT_ABS = path.resolve(REPO_ROOT);
/** Path for structured JSON log output. */
export const LOG_PATH = process.env.TEROK_LOG || path.join("/var/log", "terok-web-ui.log");

const HOME_DIR = os.homedir?.() ?? process.env.HOME ?? "";
/** Path to Codex CLI config file (for default model/effort settings). */
export const CODEX_CONFIG_PATH =
  process.env.CODEX_CONFIG || path.join(HOME_DIR, ".codex", "config.toml");
/** Path to Codex CLI auth file (for OpenAI/ChatGPT authentication). */
export const CODEX_AUTH_PATH = process.env.CODEX_AUTH || path.join(HOME_DIR, ".codex", "auth.json");

function readConfigValue(regex: RegExp): string | null {
  try {
    if (!CODEX_CONFIG_PATH) return null;
    const contents = fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
    const match = contents.match(regex);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

const DEFAULT_MODEL_FROM_CONFIG = readConfigValue(/^\s*model\s*=\s*"([^"]+)"/m);
const DEFAULT_EFFORT_FROM_CONFIG = readConfigValue(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);

export const DEFAULT_MODEL: string | null =
  process.env.TEROK_MODEL || DEFAULT_MODEL_FROM_CONFIG || null;
export const EFFORT_OPTIONS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof EFFORT_OPTIONS)[number];

function normalizeEffort(value: string | null | undefined): ReasoningEffort | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return (EFFORT_OPTIONS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningEffort)
    : null;
}

export const DEFAULT_EFFORT: ReasoningEffort | null = normalizeEffort(
  process.env.TEROK_EFFORT || DEFAULT_EFFORT_FROM_CONFIG
);
export const MODEL_CACHE_TTL_MS = Number(process.env.TEROK_MODEL_CACHE_MS || 5 * 60 * 1000);

export const SKIP_GIT_REPO_CHECK =
  process.env.TEROK_SKIP_GIT_CHECK === "1" || !fs.existsSync(path.join(REPO_ROOT_ABS, ".git"));

/**
 * Resolves a relative path within the repository root.
 *
 * NOTE: While the container context provides isolation, this validation
 * is retained for defense-in-depth and to prevent accidental access to
 * container system files that might contain secrets (e.g., /root/.claude/).
 * The validation cost is negligible (~1ms) and provides an extra safety layer.
 *
 * @param relPath - Path relative to REPO_ROOT (e.g., "src/index.ts")
 * @returns Object with absolute path and normalized relative path
 * @throws Error if path would escape REPO_ROOT
 */
export function resolveRepoPath(relPath: string = ""): { abs: string; rel: string } {
  const normalized = typeof relPath === "string" ? relPath.replace(/^[/\\]+/, "") : "";
  const abs = path.resolve(REPO_ROOT_ABS, normalized || ".");
  const relative = path.relative(REPO_ROOT_ABS, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes repository");
  }
  return {
    abs,
    rel: relative === "" ? "" : relative.replace(/\\/g, "/")
  };
}
