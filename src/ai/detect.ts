// What the AI server can do: its kind (GET /models, owned_by "vllm") and whether the model sees pictures (one tiny picture).
// Test Connection finds both; for settings without them, the first AI request of a session finds them on the side (detectServer).
import type { Backend } from '../backend/backend';
import { loadAiSettings, saveAiSettings, type AiSettings } from './settings';
import { AI_CUT_OFF } from './sse';
import type { AiModel } from './types';

/** A 32 x 32 grey PNG. */
export const PROBE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKUlEQVR42u3NQQEAAAQEMPQPddGU4LcVWCepT1PPBAKBQCAQCAQCwZUF1UQCgPcEspYAAAAASUVORK5CYII=';
/** The longest the first request waits for the detection (it goes on and is saved afterwards). */
export const DETECT_WAIT_MS = 3000;

/** An error that says the server or model takes no pictures. */
export const isVisionError = (message: string): boolean => /image|multi-?modal|vision|\bmm\b|limit_mm/i.test(message);

/**
 * Whether `model` accepts a picture: one request with PROBE_PNG and max_tokens 1. True when the server takes it (a cut-off or
 * empty answer included), false when its error is about pictures, undefined for any other error.
 */
export async function probeVision(backend: Pick<Backend, 'aiChat'>, baseUrl: string, apiKey: string, model: string): Promise<boolean | undefined> {
  try {
    await backend.aiChat(baseUrl, apiKey, model,
      [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }, { type: 'image_url', image_url: { url: PROBE_PNG } }] }], undefined, { maxTokens: 1 });
    return true;
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (m === AI_CUT_OFF || /could not read/.test(m)) return true;
    return isVisionError(m) ? false : undefined;
  }
}

/** "baseUrl|model" pairs already detected in this session. */
const detected = new Set<string>();

/** What detectServer finds: `listed` (server kind and context size, from GET /models) comes before `done` (that plus vision). */
export interface Detecting { listed: Promise<Partial<AiSettings>>; done: Promise<Partial<AiSettings>> }

/** Saves `found` into the settings when they still name the same server and model (else it is found again next session). */
async function saveFound(backend: Pick<Backend, 'loadSettings' | 'saveSettings'>, s: AiSettings, found: Partial<AiSettings>): Promise<void> {
  if (!Object.keys(found).length) return;
  try {
    const cur = await loadAiSettings(backend);
    if (cur.baseUrl.trim() === s.baseUrl.trim() && cur.model.trim() === s.model.trim()) await saveAiSettings(backend, { ...cur, ...found });
  } catch { /* not saved: found again next session */ }
}

/**
 * Finds what `s` does not know yet: the server kind and context size (GET /models) and, unless "Send form picture" is Off, vision
 * (probeVision, only for a model the server lists). Once per server and model per session. The server kind is known (and saved)
 * as soon as the list is in, before the picture probe, which can be slow; the vision result is saved when the probe is done.
 */
export function detectServer(backend: Pick<Backend, 'aiListModels' | 'aiChat' | 'loadSettings' | 'saveSettings'>, s: AiSettings): Detecting {
  const key = `${s.baseUrl.trim()}|${s.model.trim()}`;
  const needVision = s.vision === undefined && s.formPicture !== 'off';
  if (detected.has(key) || (s.serverKind && !needVision)) { const none = Promise.resolve({}); return { listed: none, done: none }; }
  detected.add(key);
  const listing = (async (): Promise<Partial<AiSettings> | null> => {
    const list = await Promise.resolve().then(() => backend.aiListModels(s.baseUrl, s.apiKey)).catch((): AiModel[] => []);
    const found = Array.isArray(list) ? list.find(m => m.id.toLowerCase() === s.model.trim().toLowerCase()) : undefined;
    if (!found) return null;
    const out: Partial<AiSettings> = {};
    if (!s.serverKind) out.serverKind = found.ownedBy === 'vllm' ? 'vllm' : 'openai';
    if (!s.contextTokens && found.contextTokens) out.contextTokens = found.contextTokens;
    await saveFound(backend, s, out);
    return out;
  })();
  const done = listing.then(async (out): Promise<Partial<AiSettings>> => {
    if (!out) return {};
    if (!needVision) return out;
    const v = await probeVision(backend, s.baseUrl, s.apiKey, s.model);
    if (v === undefined) return out;
    await saveFound(backend, s, { vision: v });
    return { ...out, vision: v };
  });
  return { listed: listing.then(out => out ?? {}), done };
}

/**
 * `s` with what `detecting` found within `ms`: all of it, or (when the picture probe is slower) the server kind and context size
 * if the list was in by then. Later results are still saved by detectServer.
 */
export async function withDetected(s: AiSettings, detecting: Detecting, ms = DETECT_WAIT_MS): Promise<AiSettings> {
  let listed: Partial<AiSettings> = {};
  detecting.listed.then(v => { listed = v; }, () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); });
  const got = await Promise.race([detecting.done.catch(() => ({})), late]);
  clearTimeout(timer);
  return { ...s, ...(got ?? listed) };
}
