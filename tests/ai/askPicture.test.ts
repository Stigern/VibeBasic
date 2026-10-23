// @vitest-environment jsdom
// Form mode with pictures: the first request carries the form's picture, the check round a picture of the proposal,
// a server that refuses pictures gets the request again without them, and the server is detected lazily.
import { afterEach, expect, test, vi } from 'vitest';
import { askAi, formPictures } from '../../src/ai/askDialog';
import { buildFormRequest } from '../../src/ai/context';
import { FORM_STRUCTURED_OUTPUTS } from '../../src/ai/formMode';
import type { ContentPart } from '../../src/ai/types';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newControl, newProject } from '../../src/model/controls';

const PNG = 'data:image/png;base64,AAAA';
formPictures.render = async () => PNG;
afterEach(() => { document.body.innerHTML = ''; });

const fakeBackend = (settings: Record<string, unknown>, chat: (...a: any[]) => Promise<string>, models: unknown[] = []) => {
  const store = new Map<string, unknown>([['ai', { baseUrl: 'http://x/v1', apiKey: '', ...settings }]]);
  return {
    store,
    loadSettings: async (k: string) => store.get(k) ?? null,
    saveSettings: async (k: string, v: unknown) => { store.set(k, v); },
    aiListModels: vi.fn(async () => models),
    aiChat: vi.fn(chat),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn>; store: Map<string, unknown> };
};
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
function designer() {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.controls.push(newControl(f, 'CommandButton', { left: 240, top: 240 }, null));
  s.setActiveView({ kind: 'designer', formId: f.id });
  return s;
}
async function askForm(b: Backend, s = designer()) {
  const p = askAi(s, b, { codeWindowFor: () => null });
  await vi.waitFor(() => expect(document.querySelector('.ai-prompt')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = 'make a login form';
  btn('OK')!.click();
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  btn('Cancel')!.click();
  await p;
}
const sent = (b: { aiChat: ReturnType<typeof vi.fn> }, i: number) => b.aiChat.mock.calls[i][3] as { role: string; content: string | ContentPart[] }[];
const pictures = (m: { content: string | ContentPart[] }[]) => m.flatMap(x => (typeof x.content === 'string' ? [] : x.content.filter(p => p.type === 'image_url')));
const CLEAN = '{"ops":[{"op":"set","name":"Command1","props":{"Caption":"Go"}}]}';
const OVERLAP = '{"ops":[{"op":"add","type":"CommandButton","name":"cmdX","props":{"Caption":"X","Left":300,"Top":300,"Width":1215,"Height":375}}]}';

test('the form request carries one picture after the text; the system prompt stays byte-identical', async () => {
  const b = fakeBackend({ model: 'pic-1' }, async () => CLEAN);
  const s = designer();
  await askForm(b, s);
  const m = sent(b, 0);
  const parts = m[1].content as ContentPart[];
  expect(parts.map(p => p.type)).toEqual(['text', 'image_url']);
  expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: PNG } });
  expect((parts[0] as { text: string }).text).toContain('Layout map of the client area');
  const other = newProject();
  expect(m[0].content).toBe(buildFormRequest(other, other.forms[0].id, 'something else')[0].content);
  expect(b.aiChat).toHaveBeenCalledTimes(1);
});

test('layout problems get a check round with a picture of the proposal', async () => {
  const b = fakeBackend({ model: 'pic-2' }, vi.fn().mockResolvedValueOnce(OVERLAP).mockResolvedValueOnce(CLEAN));
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  const m = sent(b, 1);
  const last = m[m.length - 1].content as ContentPart[];
  expect(last.map(p => p.type)).toEqual(['text', 'image_url']);
  expect((last[0] as { text: string }).text).toMatch(/Command1 .* and cmdX .* overlap[\s\S]*This is how your proposal looks; fix the listed layout problems\./);
  expect(pictures(m)).toHaveLength(2);
});

test('a server that refuses pictures gets the request again without them, and no more pictures this session', async () => {
  const b = fakeBackend({ model: 'pic-3' }, async (...a: any[]) => {
    if (pictures(a[3]).length) throw new Error('The AI server answered 400: image input is not supported by this model');
    return CLEAN;
  });
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(pictures(sent(b, 0))).toHaveLength(1);
  expect(pictures(sent(b, 1))).toHaveLength(0);
  expect(JSON.stringify(sent(b, 1)[1].content)).toContain('[picture omitted]');
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(3);
  expect(pictures(sent(b, 2))).toHaveLength(0);
});

test('unknown server kind and vision are detected on the first request and saved', async () => {
  const b = fakeBackend({ model: 'pic-4' }, async (...a: any[]) => (a[5]?.maxTokens === 1 ? 'OK' : CLEAN), [{ id: 'pic-4', ownedBy: 'vllm', contextTokens: 262144 }]);
  await askForm(b);
  const probe = b.aiChat.mock.calls[0];
  expect(pictures(probe[3])).toHaveLength(1);
  expect(probe[5].maxTokens).toBe(1);
  expect(b.store.get('ai')).toMatchObject({ serverKind: 'vllm', vision: true, contextTokens: 262144 });
  expect(b.aiChat.mock.calls[1][5].structuredOutputs).toEqual(FORM_STRUCTURED_OUTPUTS);
  // once per server: the next request does not probe again
  await askForm(b);
  expect(b.aiChat).toHaveBeenCalledTimes(3);
});
