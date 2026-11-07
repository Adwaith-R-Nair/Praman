import { Err, Ok, type Result } from "@praman/shared";

export const CHANNEL3_SEARCH_URL = "https://api.trychannel3.com/v1/search";
export const CHANNEL3_TIMEOUT_MS = 15_000;

export interface Channel3Config {
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
}

/** What a refusal means, in words an operator can act on. The key is never part of any message. */
function describeStatus(status: number): string {
  if (status === 401 || status === 403) return "Channel3 refused the API key";
  if (status === 402) return "Channel3 wants payment before it answers (out of credits?)";
  if (status === 429) return "Channel3 is rate limiting this key";
  if (status >= 500) return `Channel3 is unavailable (HTTP ${status.toString()})`;
  return `Channel3 answered HTTP ${status.toString()}`;
}

/**
 * One search call, returning the raw body so prices can be read from their source
 * text (see parse.ts). Each call costs a Channel3 credit, so callers keep the
 * number of queries small.
 */
export async function searchChannel3(config: Channel3Config, query: string, limit: number): Promise<Result<string, string>> {
  let res: Response;
  try {
    res = await config.fetch(CHANNEL3_SEARCH_URL, {
      method: "POST",
      headers: { "x-api-key": config.apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(CHANNEL3_TIMEOUT_MS),
    });
  } catch (err) {
    return Err(`Channel3 could not be reached: ${err instanceof Error ? err.name : "unknown error"}`);
  }
  if (!res.ok) return Err(describeStatus(res.status));
  return Ok(await res.text());
}
