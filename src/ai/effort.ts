// Thinking levels a server accepts. vLLM with a Qwen chat template answers an unknown reasoning_effort with HTTP 400 and the
// list it supports ("Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low."). Such a 400 is
// retried once with the nearest level it lists, and the mapping is kept per base URL for the rest of the session. Test
// Connection asks for the list on purpose (probeEfforts) and shows it. Works the same with both backends: they report an HTTP
// error alike ("The AI server answered 400 ...: <message>").
import type { Backend } from '../backend/backend';

/** The levels in order of how much they think. */
const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** The levels a reasoning-effort error lists (lower case, in its order, "(default)" dropped), or null when it is no such error. */
export function supportedEfforts(message: string): string[] | null {
  if (!/\b(400|422)\b/.test(message) || !/reasoning[ _-]?effort/i.test(message)) return null;
  const m = /supported (?:types|values|levels|options)?\s*(?:are|is|:)\s*([^.\n]+)/i.exec(message);
  if (!m) return null;
  const levels = m[1].replace(/\(default\)/gi, '').split(/,|\bor\b|\band\b/i).map(s => s.trim().replace(/^["'`]|["'`]$/g, '').toLowerCase()).filter(s => /^[a-z]+$/.test(s));
  return levels.length ? [...new Set(levels)] : null;
}

/** The level the error names as the default ("xhigh (default)"), if any. */
export function defaultEffort(message: string): string | undefined {
  return /([a-z]+)\s*\(default\)/i.exec(message)?.[1].toLowerCase();
}

/**
 * The supported level nearest to `wanted` in thinking: the same one when listed, else the closest by order; on a tie the
 * lower one (the answer budget, max_tokens, was sized for `wanted`, and the higher level thinks longer). Levels outside the
 * known order count as the farthest.
 */
export function nearestEffort(wanted: string, supported: string[]): string | undefined {
  const w = wanted.toLowerCase();
  if (supported.includes(w)) return w;
  const at = ORDER.indexOf(w);
  let best: string | undefined, dist = Infinity;
  for (const s of supported) {
    const i = ORDER.indexOf(s);
    const d = at < 0 || i < 0 ? 100 : Math.abs(i - at) + (i > at ? 0.5 : 0);
    if (d < dist) { best = s; dist = d; }
  }
  return best;
}

/** Per base URL: the levels the server said it accepts (this session). */
const known = new Map<string, string[]>();
const key = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '').toLowerCase();

/** Remembers the levels a server accepts. */
export function rememberEfforts(baseUrl: string, levels: string[]): void { known.set(key(baseUrl), levels); }
/** The levels a server is known to accept, or undefined. */
export const knownEfforts = (baseUrl: string): string[] | undefined => known.get(key(baseUrl));
/** Forgets everything (tests). */
export function resetEfforts(): void { known.clear(); }

/** The level to send for `wanted` to the server at `baseUrl`: mapped when the server is known not to take `wanted`. */
export function effortFor(baseUrl: string, wanted: string | undefined): string | undefined {
  if (!wanted) return wanted;
  const levels = knownEfforts(baseUrl);
  return levels ? nearestEffort(wanted, levels) ?? wanted : wanted;
}

/**
 * Learns from a failed request: when `message` is a reasoning-effort 400, the levels are remembered and the level to retry
 * with is returned (undefined when there is none, or it would be the same level again).
 */
export function retryEffort(baseUrl: string, sent: string | undefined, message: string): string | undefined {
  const levels = supportedEfforts(message);
  if (!levels || !sent) return undefined;
  rememberEfforts(baseUrl, levels);
  const next = nearestEffort(sent, levels);
  return next && next !== sent ? next : undefined;
}

/** A level no server has: its 400 lists the ones it takes. */
export const PROBE_EFFORT = 'vibebasic-probe';

/**
 * What Test Connection learns about reasoning_effort, with one tiny request (max_tokens 1) at a level no server has:
 * `levels` when the server lists the ones it takes (it then supports reasoning_effort), null when it took the request or
 * failed some other way (unknown: it may ignore the field).
 */
export async function probeEfforts(backend: Pick<Backend, 'aiChat'>, baseUrl: string, apiKey: string, model: string): Promise<{ levels: string[]; default?: string } | null> {
  try {
    await backend.aiChat(baseUrl, apiKey, model, [{ role: 'user', content: 'Reply with OK.' }], PROBE_EFFORT, { maxTokens: 1 });
    return null;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    const levels = supportedEfforts(m);
    if (!levels) return null;
    rememberEfforts(baseUrl, levels);
    const d = defaultEffort(m);
    return { levels, ...(d ? { default: d } : {}) };
  }
}
