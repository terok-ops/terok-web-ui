import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const THEME_KEY = "terok-web-ui-theme";

const inlineScripts: string[] = (() => {
  const { document } = parseHTML(indexHtml);
  return Array.from(document.querySelectorAll("script"))
    .filter((script) => !script.getAttribute("src"))
    .map((script) => script.textContent);
})();

function extractRule(pattern: string): boolean {
  return new RegExp(pattern, "i").test(indexHtml);
}

test("commands pane keeps monospace styling declarations", () => {
  assert.ok(
    extractRule("#commands\\s*{[^}]*font-family:[^}]*monospace"),
    "commands pane should enforce a monospace font family"
  );
  assert.ok(
    extractRule("\\.cmd\\s*{[^}]*white-space:\\s*pre-wrap"),
    "individual command blocks should preserve whitespace"
  );
});

test("appendCommandBlock renders <pre> entries with matching classes", async () => {
  const { context, document } = await bootstrapUi();
  context.appendCommandBlock("echo test", "start");
  context.appendCommandBlock("done", "output");
  const blocks = Array.from(document.querySelectorAll("#commands pre"));
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].className, "cmd cmd-start");
  assert.equal(blocks[0].textContent, "echo test");
  assert.equal(blocks[1].className, "cmd cmd-output");
  assert.equal(blocks[1].textContent, "done");
});

test("theme toggle cycles preferences and persists manual selection", async () => {
  const { document, context, localStorage } = await bootstrapUi({ prefersDark: true });
  const button = document.getElementById("themeToggle");
  assert.ok(button);
  const buttonEl = button as HTMLElement;
  assert.equal(buttonEl.textContent, "Theme: Auto (Dark)");
  buttonEl.dispatchEvent(new context.window.Event("click"));
  assert.equal(document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(localStorage.getItem(THEME_KEY), "light");
  assert.equal(buttonEl.textContent, "Theme: Light");
  buttonEl.dispatchEvent(new context.window.Event("click"));
  assert.equal(document.documentElement.getAttribute("data-theme"), null);
  assert.equal(localStorage.getItem(THEME_KEY), null);
  assert.equal(buttonEl.textContent, "Theme: Auto (Dark)");
});

test("stored theme preference is applied immediately on load", async () => {
  const { document, localStorage } = await bootstrapUi({ storedTheme: "dark", prefersDark: false });
  const button = document.getElementById("themeToggle");
  assert.ok(button);
  const buttonEl = button as HTMLElement;
  assert.equal(localStorage.getItem(THEME_KEY), "dark");
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(buttonEl.textContent, "Theme: Dark");
});

test("auto theme label updates when system preference changes", async () => {
  const { document, themeMediaMock, context } = await bootstrapUi({ prefersDark: false });
  const button = document.getElementById("themeToggle");
  assert.ok(button);
  const buttonEl = button as HTMLElement;
  assert.equal(buttonEl.textContent, "Theme: Auto (Light)");
  themeMediaMock.dispatchChange(true);
  await nextTick();
  assert.equal(buttonEl.textContent, "Theme: Auto (Dark)");
  buttonEl.dispatchEvent(new context.window.Event("click"));
  themeMediaMock.dispatchChange(false);
  await nextTick();
  assert.equal(buttonEl.textContent, "Theme: Light", "manual preference should block auto updates");
});

type StorageMock = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function createLocalStorage(initial: Record<string, string> = {}): StorageMock {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    }
  };
}

type ThemeMediaMock = {
  readonly matches: boolean;
  addEventListener(event: string, cb: (event: { matches: boolean }) => void): void;
  removeEventListener(event: string, cb: (event: { matches: boolean }) => void): void;
  dispatchChange(nextValue: boolean): void;
  media: string;
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null;
  addListener(listener: (this: MediaQueryList, ev: MediaQueryListEvent) => unknown): void;
  removeListener(listener: (this: MediaQueryList, ev: MediaQueryListEvent) => unknown): void;
  dispatchEvent(event: Event): boolean;
};

function createThemeMediaMock(prefersDark = false): ThemeMediaMock {
  let matches = !!prefersDark;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  return {
    media: "",
    onchange: null,
    get matches() {
      return matches;
    },
    addEventListener(event: string, cb: (event: { matches: boolean }) => void) {
      if (event === "change") listeners.add(cb);
    },
    removeEventListener(event: string, cb: (event: { matches: boolean }) => void) {
      if (event === "change") listeners.delete(cb);
    },
    dispatchChange(nextValue: boolean) {
      matches = !!nextValue;
      listeners.forEach((cb) => cb({ matches }));
    },
    addListener(listener: (this: MediaQueryList, ev: MediaQueryListEvent) => unknown) {
      listeners.add(() =>
        listener.call({ matches } as MediaQueryList, { matches } as MediaQueryListEvent)
      );
    },
    removeListener(listener: (this: MediaQueryList, ev: MediaQueryListEvent) => unknown) {
      listeners.forEach((cb) => {
        if ((cb as unknown) === listener) listeners.delete(cb);
      });
    },
    dispatchEvent(_event: Event) {
      return false;
    }
  };
}

type BootstrapOptions = { storedTheme?: string | null; prefersDark?: boolean };

async function bootstrapUi({ storedTheme = null, prefersDark = false }: BootstrapOptions = {}) {
  const { window, document } = parseHTML(indexHtml);
  const localStorage = createLocalStorage(storedTheme ? { [THEME_KEY]: storedTheme } : {});
  Object.defineProperty(window, "localStorage", { value: localStorage, configurable: true });
  const promptStub = () => null;
  const optionCtor =
    window.Option ||
    function Option(text: string, value: string = "") {
      const el = document.createElement("option");
      el.textContent = text;
      el.value = value;
      return el;
    };
  window.prompt = promptStub;
  window.Option = optionCtor;

  const themeMediaMock = createThemeMediaMock(prefersDark);
  window.matchMedia = () => themeMediaMock as unknown as MediaQueryList;

  let currentSettings: Record<string, unknown> = {
    model: null,
    defaultModel: "gpt-4o",
    effort: null,
    defaultEffort: "medium",
    availableModels: ["gpt-4o-mini"],
    effortOptions: ["minimal", "low", "medium", "high", "xhigh"]
  };

  window.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url.startsWith("/api/model")) {
      if ((options.method || "GET").toUpperCase() === "POST") {
        const body = options.body ? JSON.parse(options.body as string) : {};
        if (Object.prototype.hasOwnProperty.call(body, "model")) {
          currentSettings = { ...currentSettings, model: body.model || null };
        }
        if (Object.prototype.hasOwnProperty.call(body, "effort")) {
          currentSettings = { ...currentSettings, effort: body.effort || null };
        }
      }
      return makeResponse(currentSettings);
    }
    if (url.startsWith("/api/list")) return makeResponse({ entries: [] });
    if (url.startsWith("/api/apply")) return makeResponse({ ok: true, output: "" });
    if (url.startsWith("/api/send")) return makeResponse({ runId: "test-run" });
    return makeResponse({});
  }) as typeof window.fetch;

  class EventSourceStub {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    readonly CONNECTING = EventSourceStub.CONNECTING;
    readonly OPEN = EventSourceStub.OPEN;
    readonly CLOSED = EventSourceStub.CLOSED;
    readyState = EventSourceStub.CLOSED;
    url = "";
    withCredentials = false;
    onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
    onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
    onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

    constructor() {
      throw new Error("EventSource should not be constructed in tests");
    }

    close() {}
  }

  window.EventSource = EventSourceStub as unknown as typeof EventSource;

  const context: any = {
    window,
    document,
    console,
    localStorage,
    fetch: window.fetch,
    EventSource: window.EventSource,
    matchMedia: window.matchMedia,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Option: window.Option,
    prompt: window.prompt
  };
  context.globalThis = context as typeof globalThis;
  vm.createContext(context);
  inlineScripts.forEach((code, idx) =>
    vm.runInContext(code, context, { filename: `inline-script-${idx}.js` })
  );
  await nextTick();
  return { window, document, context, themeMediaMock, localStorage };
}

function makeResponse(payload: Record<string, unknown>) {
  return {
    ok: true,
    async json() {
      return payload;
    }
  };
}

function nextTick() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
