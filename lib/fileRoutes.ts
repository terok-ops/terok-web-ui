/**
 * File operations router.
 *
 * Provides REST endpoints for file browsing and editing within the repository:
 * - GET /api/list - List directory contents
 * - GET /api/read - Read file contents
 * - POST /api/save - Write file contents
 * - POST /api/apply/:id - Apply a diff patch from a run
 *
 * All paths are relative to REPO_ROOT and validated to prevent directory traversal.
 * In the isolated container context, these operations have full access.
 */
import { Router, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { REPO_ROOT, REPO_ROOT_ABS, resolveRepoPath } from "./config.js";
import { getLastDiff } from "./runStore.js";

export const fileRouter = Router();

/**
 * List directory contents, sorted with directories first.
 */
fileRouter.get("/list", (req: Request, res: Response) => {
  const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
  try {
    const { abs, rel } = resolveRepoPath(requestedPath);
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((dirent) => ({ name: dirent.name, dir: dirent.isDirectory() }));

    res.json({ root: REPO_ROOT_ABS, path: rel, entries });
  } catch (error) {
    res.json({ root: REPO_ROOT_ABS, path: requestedPath, entries: [], error: String(error) });
  }
});

/**
 * Read file contents. Returns 400 for directories.
 */
fileRouter.get("/read", (req: Request, res: Response) => {
  const requestedPath = req.query.path;
  if (typeof requestedPath !== "string" || !requestedPath) {
    return res.status(400).json({ error: "path is required" });
  }
  try {
    const { abs, rel } = resolveRepoPath(requestedPath);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Path is a directory" });
    }
    const content = fs.readFileSync(abs, "utf8");
    res.json({ path: rel, content });
  } catch (error) {
    res.status(400).json({ error: String(error) });
  }
});

/**
 * Write file contents. Creates parent directories as needed.
 */
fileRouter.post("/save", (req: Request, res: Response) => {
  const body = req.body as { path?: unknown; content?: unknown };
  const relPath = body?.path;
  if (typeof relPath !== "string" || !relPath) {
    return res.status(400).json({ ok: false, error: "path is required" });
  }
  const content = typeof body?.content === "string" ? body.content : "";
  try {
    const { abs, rel } = resolveRepoPath(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    res.json({ ok: true, path: rel });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

/**
 * Apply a diff patch from a previous run using git apply.
 * Creates a temporary patch file, applies it, then cleans up.
 */
fileRouter.post("/apply/:id", async (req: Request, res: Response) => {
  const patch = getLastDiff(req.params.id);
  if (!patch) return res.json({ ok: false, output: "No diff available" });

  const tmp = path.join(REPO_ROOT, `.terok-web-ui-${crypto.randomUUID()}.patch`);
  try {
    fs.writeFileSync(tmp, patch, "utf8");
    const p = spawn("bash", ["-lc", `git apply --index '${tmp.replace(/'/g, "'\\''")}'`], {
      cwd: REPO_ROOT
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Cleanup failure is non-fatal
      }
      res.json({ ok: code === 0, output: out });
    });
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Cleanup failure is non-fatal
    }
    res.json({ ok: false, output: String(e) });
  }
});
