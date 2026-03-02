import fs from "node:fs";

import { LOG_PATH } from "./config.js";

let logStream: fs.WriteStream | null;
try {
  logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  console.log(`Logging Terok Web UI activity to ${LOG_PATH}`);
} catch (error) {
  console.error("Failed to open log file, falling back to console only", error);
  logStream = null;
}

function serializeLogData(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function logRun(id: string, message: string, data?: unknown): void {
  const ts = new Date().toISOString();
  const serialized = serializeLogData(data);
  const line = `[${ts}] [run ${id}] ${message}${serialized ? ` — ${serialized}` : ""}`;
  console.log(line);
  logStream?.write(line + "\n");
}
