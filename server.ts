/**
 * Main server entry point for Terok Web UI.
 *
 * This Express server provides:
 * - REST API for creating runs and managing model settings
 * - SSE streaming for real-time AI response events
 * - File browsing/editing endpoints (delegated to fileRoutes)
 * - Static file serving for the web UI
 *
 * Designed to run in an isolated container with full access to /workspace.
 * All operations are single-user and single-backend per container instance.
 */
import express, { Request, Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { hydrateEnv } from "./lib/env.js";
import { REPO_ROOT, HOST, PORT, SKIP_GIT_REPO_CHECK } from "./lib/config.js";
import { logRun } from "./lib/logging.js";
import {
  createRun,
  getRun,
  appendCommandLog,
  setLastDiff,
  getLastDiff,
  getCommands
} from "./lib/runStore.js";
import { getBackend } from "./lib/backends/index.js";
import { fileRouter } from "./lib/fileRoutes.js";
import type { BackendEvent, ModelSelectionPayload } from "./lib/backends/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, "static");

// Load environment variables from .env files and Claude credentials
hydrateEnv();

const app = express();
app.use(express.json());
app.use("/static", express.static(staticDir));

// Initialize the backend (Codex, Claude, or Mistral based on TEROK_BACKEND env)
// Configuration is fixed for container context: full access, no approval needed
const backend = getBackend({
  workingDirectory: REPO_ROOT,
  skipGitRepoCheck: SKIP_GIT_REPO_CHECK,
  sandboxMode: "danger-full-access",
  networkAccessEnabled: true,
  approvalPolicy: "never"
});

// Mount file operations router
app.use("/api", fileRouter);

// Read and cache the index.html template
const indexHtmlPath = path.join(staticDir, "index.html");
const indexHtmlTemplate = fs.readFileSync(indexHtmlPath, "utf-8");

// Generate dynamic page title from PROJECT_ID environment variable
const projectId = process.env.PROJECT_ID || "(unknown project)";
const pageTitle = `Terok: ${projectId}`;
const indexHtml = indexHtmlTemplate.replace(
  /<title>Terok Web UI<\/title>/,
  `<title>${pageTitle}</title>`
);

// Serve dynamic index.html
app.get("/", (_req: Request, res: Response) => {
  res.type("html").send(indexHtml);
});

/**
 * Create a new run with the given prompt.
 * Returns a UUID that can be used to stream results.
 */
app.post("/api/send", async (req: Request, res: Response) => {
  const body = req.body as { text?: unknown };
  const prompt = String(body?.text ?? "");
  const runId = createRun(prompt);
  logRun(runId, "Created run", {
    promptPreview: prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt
  });
  res.json({ runId });
});

/**
 * Stream run results via Server-Sent Events.
 *
 * Events emitted:
 * - thinking: Model's internal reasoning (if available)
 * - message: Text response chunks
 * - tool.start/stdout/stderr/end: Command execution tracking
 * - diff: Unified patch for file changes
 * - status: Progress updates
 * - done: Completion signal
 * - error: Error message if run fails
 */
app.get("/api/stream/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  const run = getRun(id);
  if (!run) return res.status(404).json({ error: "no such run" });

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.flushHeaders?.();

  const send = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  let clientClosed = false;

  logRun(id, "SSE stream opened");
  req.on("close", () => {
    if (!clientClosed) {
      clientClosed = true;
      logRun(id, `HTTP client disconnected; stopping ${backend.name} stream`);
    }
  });

  /**
   * Translates backend events to SSE messages.
   * Also maintains run state (command logs, last diff).
   */
  const handleBackendEvent = (event: BackendEvent): void => {
    switch (event.type) {
      case "tool.start":
        appendCommandLog(id, `$ ${event.tool.name}`);
        send(event);
        return;
      case "tool.stdout":
      case "tool.stderr":
        appendCommandLog(id, event.text);
        send(event);
        return;
      case "tool.end":
        send(event);
        return;
      case "diff":
        setLastDiff(id, event.diff.patch);
        send(event);
        return;
      default:
        send(event);
    }
  };

  try {
    const events = await backend.streamRun(run.prompt);
    const iterator = events[Symbol.asyncIterator]();
    while (true) {
      const { value, done } = await iterator.next();
      if (done || clientClosed) {
        if (clientClosed) await iterator.return?.();
        break;
      }
      handleBackendEvent(value);
    }
    if (!clientClosed) {
      logRun(id, `${backend.name} run completed`);
      send({ type: "done" });
    }
  } catch (e) {
    logRun(id, `${backend.name} run error`, e instanceof Error ? e.stack || e.message : e);
    send({ type: "error", error: String(e instanceof Error ? e.message : e) });
  } finally {
    logRun(id, "SSE stream closing");
    res.end();
  }
});

// Run state accessors
app.get("/api/last-diff/:id", (req: Request, res: Response) => {
  res.json({ diff: getLastDiff(req.params.id) });
});
app.get("/api/cmd-log/:id", (req: Request, res: Response) => {
  res.json({ commands: getCommands(req.params.id) });
});

// Backend info (for client to show appropriate warnings)
app.get("/api/info", (_req: Request, res: Response) => {
  res.json({ backend: backend.name });
});

// Model settings
app.get("/api/model", async (_req: Request, res: Response) => {
  res.json(await backend.getModelSettings());
});

app.post("/api/model", async (req: Request, res: Response) => {
  backend.updateModelSelection(req.body as ModelSelectionPayload);
  const settings = await backend.getModelSettings();
  logRun("model", "Model selection updated", {
    activeModel: settings.model || "(default)",
    defaultModel: settings.defaultModel || "(none)",
    activeEffort: settings.effort || "(default)",
    defaultEffort: settings.defaultEffort || "(none)"
  });
  res.json(settings);
});

app.listen(PORT, HOST, () =>
  console.log(`Terok Web UI started (SDK streaming) on http://${HOST}:${PORT} — repo ${REPO_ROOT}`)
);
