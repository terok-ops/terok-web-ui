const OAUTH_API_KEY_URL = "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";

type CachedKey = {
  oauthToken: string;
  apiKey: string;
  fetchedAt: number;
};

let cachedKey: CachedKey | null = null;
let inflightRequest: Promise<string | null> | null = null;

function getClaudeOauthToken(): string | null {
  return (
    process.env.TEROK_CLAUDE_OAUTH_ACCESS_TOKEN || process.env.CLAUDE_OAUTH_ACCESS_TOKEN || null
  );
}

export function getClaudeApiKey(): string | null {
  return (
    process.env.TEROK_CLAUDE_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    null
  );
}

function shouldReuseCachedKey(oauthToken: string): boolean {
  if (!cachedKey || cachedKey.oauthToken !== oauthToken) return false;
  const ttlMs = Number(process.env.TEROK_CLAUDE_OAUTH_CACHE_MS || 5 * 60 * 1000);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  return Date.now() - cachedKey.fetchedAt < ttlMs;
}

async function mintApiKey(oauthToken: string): Promise<string | null> {
  if (typeof fetch !== "function") return null;
  const response = await fetch(OAUTH_API_KEY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${oauthToken}`
    }
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude OAuth request failed (${response.status}): ${errorText}`);
  }
  const payload = (await response.json()) as { raw_key?: unknown; api_key?: unknown };
  const rawKey =
    typeof payload.raw_key === "string" && payload.raw_key.trim()
      ? payload.raw_key.trim()
      : typeof payload.api_key === "string" && payload.api_key.trim()
        ? payload.api_key.trim()
        : null;
  if (!rawKey) {
    throw new Error("Claude OAuth response missing API key");
  }
  return rawKey;
}

export async function resolveClaudeApiKey(): Promise<string | null> {
  const apiKey = getClaudeApiKey();
  if (apiKey) return apiKey;
  const oauthToken = getClaudeOauthToken();
  if (!oauthToken) return null;
  if (shouldReuseCachedKey(oauthToken)) return cachedKey?.apiKey ?? null;
  if (!inflightRequest) {
    inflightRequest = (async () => {
      const minted = await mintApiKey(oauthToken);
      if (minted) {
        cachedKey = { oauthToken, apiKey: minted, fetchedAt: Date.now() };
      }
      return minted;
    })().finally(() => {
      inflightRequest = null;
    });
  }
  return inflightRequest;
}
