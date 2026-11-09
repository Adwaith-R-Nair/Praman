/**
 * Which past session the public sample page at /sample shows: the mandate ids of that
 * session, comma-separated, in this environment variable. A demo session has two, the
 * story's (mnd_demo_<ref>) and the concurrency test's (mnd_demo_<ref>_h). Unset, empty
 * or malformed means this server has no sample, and then nothing links to /sample.
 *
 * It is server configuration only. No request can name a mandate here, so the page can
 * only ever show the one session the operator chose.
 */
export const SAMPLE_ENV = "SAMPLE_MANDATE_IDS";

export const MAX_SAMPLE_MANDATES = 4;

const MANDATE_ID = /^[A-Za-z0-9_-]{1,96}$/;

/** The sample's mandate ids, or none. Read on each call, so a test can set and clear it. */
export function sampleMandateIds(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env[SAMPLE_ENV];
  if (raw === undefined) return [];
  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id !== ""))];
  if (ids.length === 0 || ids.length > MAX_SAMPLE_MANDATES || !ids.every((id) => MANDATE_ID.test(id))) return [];
  return ids;
}

export function sampleConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return sampleMandateIds(env).length > 0;
}
