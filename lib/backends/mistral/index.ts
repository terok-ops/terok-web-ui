/**
 * Mistral backend implementation.
 *
 * Uses the Mistral beta conversation API for streaming interactions.
 * Implements client-side tool execution (handoffExecution: "client").
 */
import { Mistral } from "@mistralai/mistralai";

import type { Backend, BackendConfig, BackendEvent, BackendTool } from "../types.js";
import { extractDiffs, formatToolArgs } from "../utils.js";
import { getActiveModel, getModelSettings, updateModelSelection } from "./models.js";
import { executeMistralTool, getMistralToolDefinitions } from "./tools.js";

type StreamEvent = {
  data?: {
    type?: string;
    id?: string;
    name?: string;
    arguments?: string;
    toolCallId?: string;
    conversationId?: string;
    content?: unknown;
    info?: unknown;
  };
};

type ContentChunk = {
  type?: string;
  text?: string;
  thinking?: Array<{ text?: string }>;
};

function getMistralApiKey(): string | null {
  return process.env.TEROK_MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || null;
}

/**
 * Handles content chunks from Mistral stream, yielding appropriate events.
 * Supports text and thinking content types.
 */
function* handleContent(content: unknown): Generator<BackendEvent> {
  if (!content) return;
  if (typeof content === "string") {
    yield { type: "message", text: content };
    return;
  }
  if (typeof content !== "object") return;

  const chunk = content as ContentChunk;
  if (chunk.type === "text" && chunk.text) {
    yield { type: "message", text: chunk.text };
    return;
  }
  if (chunk.type === "thinking" && Array.isArray(chunk.thinking)) {
    for (const part of chunk.thinking) {
      if (part?.text) {
        yield { type: "thinking", text: part.text };
      }
    }
    return;
  }
  if (chunk.text) {
    yield { type: "message", text: chunk.text };
  }
}

export function createMistralBackend(config: BackendConfig): Backend {
  return {
    name: "mistral",
    async streamRun(prompt: string) {
      if (!config.networkAccessEnabled) {
        throw new Error("Mistral backend requires network access");
      }
      const apiKey = getMistralApiKey();
      if (!apiKey) {
        throw new Error("Missing Mistral API key (set TEROK_MISTRAL_API_KEY or MISTRAL_API_KEY)");
      }

      const mistral = new Mistral({ apiKey });
      const model = getActiveModel() || "mistral-large-latest";

      // Using Mistral beta API for conversations.
      // This API is part of @mistralai/mistralai ^1.11.0 and provides streaming conversation support.
      const tools = getMistralToolDefinitions();
      const responseFormat = { type: "text" as const };

      let stream = await mistral.beta.conversations.startStream({
        inputs: [
          {
            object: "entry",
            type: "message.input",
            role: "user",
            content: prompt
          }
        ],
        model,
        tools: tools.length ? tools : undefined,
        completionArgs: {
          responseFormat
        }
      });

      const toolState = new Map<string, BackendTool>();
      const functionState = new Map<
        string,
        { name: string; args: string; toolCallId: string; executed: boolean }
      >();
      let conversationId: string | null = null;
      let messageBuffer = "";

      return (async function* (): AsyncIterable<BackendEvent> {
        yield { type: "status", text: "Running…" };

        while (stream) {
          let nextStream: typeof stream | null = null;

          for await (const event of stream as AsyncIterable<StreamEvent>) {
            const payload = event?.data;
            if (!payload?.type) continue;

            switch (payload.type) {
              case "conversation.response.started":
                conversationId =
                  typeof payload.conversationId === "string"
                    ? payload.conversationId
                    : conversationId;
                messageBuffer = "";
                yield { type: "status", text: "Running…" };
                break;
              case "conversation.response.error": {
                let message = "Mistral stream error";
                const detail =
                  (payload as { info?: unknown; content?: unknown }).info ??
                  (payload as { info?: unknown; content?: unknown }).content ??
                  payload;
                if (detail !== undefined) {
                  const detailText =
                    typeof detail === "string"
                      ? detail
                      : (() => {
                          try {
                            return JSON.stringify(detail);
                          } catch {
                            return String(detail);
                          }
                        })();
                  message += `: ${detailText}`;
                }
                throw new Error(message);
              }
              case "message.output.delta": {
                const content = payload.content;
                for (const item of handleContent(content)) {
                  if (item.type === "message") {
                    messageBuffer += item.text;
                  }
                  yield item;
                }
                break;
              }
              case "tool.execution.started":
              case "tool.execution.delta": {
                const id = payload.id || `${payload.name || "tool"}-${payload.arguments || ""}`;
                let tool = toolState.get(id);
                if (!tool) {
                  tool = {
                    name: payload.name || "tool",
                    args: formatToolArgs(payload.arguments)
                  };
                  toolState.set(id, tool);
                  yield { type: "tool.start", tool };
                } else if (payload.arguments) {
                  tool.args = formatToolArgs(payload.arguments);
                }
                break;
              }
              case "tool.execution.done": {
                const id = payload.id || `${payload.name || "tool"}-${payload.arguments || ""}`;
                const tool = toolState.get(id) || {
                  name: payload.name || "tool",
                  args: formatToolArgs("")
                };
                yield { type: "tool.end", tool, status: "completed" };
                toolState.delete(id);
                break;
              }
              case "function.call.delta": {
                const toolCallId = payload.toolCallId || payload.id;
                if (!toolCallId) break;
                const existing = functionState.get(toolCallId);
                const name = payload.name || existing?.name || "function";
                const incomingArgs = payload.arguments || "";
                const updatedArgs = existing?.args
                  ? incomingArgs.startsWith(existing.args)
                    ? incomingArgs
                    : `${existing.args}${incomingArgs}`
                  : incomingArgs;
                const state = existing || {
                  name,
                  args: "",
                  toolCallId,
                  executed: false
                };
                state.name = name;
                state.args = updatedArgs;
                functionState.set(toolCallId, state);

                if (!state.executed) {
                  let parsed = false;
                  if (state.args.trim()) {
                    try {
                      JSON.parse(state.args);
                      parsed = true;
                    } catch {
                      parsed = false;
                    }
                  }
                  if (parsed) {
                    state.executed = true;
                    const result = await executeMistralTool(state.name, state.args, config);
                    yield { type: "tool.start", tool: result.tool };
                    if (result.stdout) yield { type: "tool.stdout", text: result.stdout };
                    if (result.stderr) yield { type: "tool.stderr", text: result.stderr };
                    yield {
                      type: "tool.end",
                      tool: result.tool,
                      exit_code: result.exitCode,
                      status: result.exitCode === 0 ? "completed" : "failed"
                    };

                    if (!conversationId) {
                      throw new Error("Missing conversation id for tool response");
                    }
                    nextStream = await mistral.beta.conversations.appendStream({
                      conversationId,
                      conversationAppendStreamRequest: {
                        inputs: [
                          {
                            object: "entry",
                            type: "function.result",
                            toolCallId: state.toolCallId,
                            result: result.result
                          }
                        ],
                        completionArgs: {
                          responseFormat
                        }
                      }
                    });
                    functionState.delete(toolCallId);
                    break;
                  }
                }
                break;
              }
              case "conversation.response.done": {
                const diffs = extractDiffs(messageBuffer);
                for (const patch of diffs) {
                  yield { type: "diff", diff: { patch } };
                }
                break;
              }
              default:
                if (payload.content) {
                  for (const item of handleContent(payload.content)) {
                    if (item.type === "message") {
                      messageBuffer += item.text;
                    }
                    yield item;
                  }
                }
                break;
            }

            if (nextStream) break;
          }

          if (nextStream) {
            stream = nextStream;
          } else {
            break;
          }
        }
      })();
    },
    getModelSettings,
    updateModelSelection
  };
}
