// @vitest-environment jsdom
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { askAi, trimConversation, aiRetry, conversationBudget, isTransientError } from '../../src/ai/askDialog';
aiRetry.delayMs = 1;   // the automatic retry of a transient error
import { registerAiOptionsTab } from '../../src/ai/optionsTab';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { buildMenus } from '../../src/ide/menus';
import { newControl, newProject } from '../../src/model/controls';

const fakeBackend = (model: string, chat: (...a: any[]) => Promise<string>) => ({
  loadSettings: async () => ({ baseUrl: 'http://x/v1', model, apiKey: '' }),
  saveSettings: async () => {},
  aiListModels: async () => [],
  aiChat: vi.fn(chat),
}) as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };

const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const click = (label: string) => btn(label)!.click();
const shown = async (label: string) => { await vi.waitFor(() => expect(btn(label)).toBeTruthy()); };
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
async function enterPrompt(t: string) {
  await shown('Ask AI');
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = t;
  click('Ask AI');
}
const codeWin = (src: string, line = 1) => {
  const w = { src, getSource: () => w.src, getCursorLine: () => line, applyChange: vi.fn((a: number, b: number, t: string) => { w.src = w.src.slice(0, a) + t + w.src.slice(b); }) };
  return w;
};
function ide(view: 'code' | 'designer' | 'none') {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.code = 'Private Sub Command1_Click()\nEnd Sub';
  f.controls.push(newControl(f, 'CommandButton', { left: 100, top: 100 }, null));
  if (view === 'code') s.setActiveView({ kind: 'code', itemId: f.id });
  if (view === 'designer') s.setActiveView({ kind: 'designer', formId: f.id });
  return s;
}
beforeAll(() => registerAiOptionsTab({ loadSettings: async () => null, saveSettings: async () => {}, aiListModels: async () => [] } as any));
afterEach(() => { document.body.innerHTML = ''; });

test('no view -> message', async () => {
  const p = askAi(ide('none'), fakeBackend('m', async () => ''), { codeWindowFor: () => null });
  await shown('OK');
  expect(text()).toContain('Open a form or a code window first.');
  click('OK');
  await p;
});

test('missing model -> setup message, then Options on the AI tab', async () => {
  const p = askAi(ide('designer'), fakeBackend('', async () => ''), { codeWindowFor: () => null });
  await shown('OK');
  expect(text()).toContain('Set up the AI server first in Tools > Options > AI.');
  click('OK');
  await vi.waitFor(() => expect(document.querySelector('.tabs98-tab.selected')?.textContent).toBe('AI'));
  click('Cancel');
  await p;
});

test('code mode happy path applies one transaction', async () => {
  const s = ide('code');
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const b = fakeBackend('m', async () => '```vb\nPrivate Sub Command1_Click()\n    MsgBox "Hi"\nEnd Sub\n```');
  const p = askAi(s, b, { codeWindowFor: () => w as any });
  await enterPrompt('say hi');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(document.querySelector('.dlg98 .title-bar-text')!.textContent).toBe('AI Suggestion');
  click('OK');
  await p;
  expect(w.applyChange).toHaveBeenCalledTimes(1);
  expect(w.src).toContain('MsgBox "Hi"');
  expect(b.aiChat.mock.calls[0][2]).toBe('m');
});

test('dialog title names the item and mode', async () => {
  const p = askAi(ide('designer'), fakeBackend('m', async () => ''), { codeWindowFor: () => null });
  await shown('Ask AI');
  expect(document.querySelector('.dlg98 .title-bar-text')!.textContent).toBe('Ask AI - Form1 (Form)');
  click('Cancel');
  await p;
});

test('cancel while waiting discards reply', async () => {
  const s = ide('code');
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  let done!: (v: string) => void;
  const b = fakeBackend('m', () => new Promise<string>(r => { done = r; }));
  const p = askAi(s, b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('Waiting for m...'));
  click('Cancel');
  await p;
  done('```vb\nPrivate Sub Command1_Click()\n    x = 1\nEnd Sub\n```');
  await new Promise(r => setTimeout(r, 20));
  expect(document.querySelector('.dlg98')).toBeNull();
  expect(w.applyChange).not.toHaveBeenCalled();
});

test('backend error shown', async () => {
  const b = fakeBackend('m', async () => { throw new Error('The AI server did not answer within 180 seconds.'); });
  const p = askAi(ide('designer'), b, { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('The AI server did not answer within 180 seconds.'));
  click('OK');
  await p;
});

test('garbage reply shows details and changes nothing', async () => {
  const s = ide('designer');
  const before = structuredClone(s.project);
  const p = askAi(s, fakeBackend('m', async () => 'Hmm.'), { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(btn('Details...')).toBeTruthy());
  expect(text()).toContain('The AI answer could not be understood. Try again or rephrase.');
  click('Details...');
  await vi.waitFor(() => expect((document.querySelector('.ai-details') as HTMLTextAreaElement)?.value).toBe('Hmm.'));
  expect((document.querySelector('.ai-details') as HTMLTextAreaElement).readOnly).toBe(true);
  click('OK');
  await vi.waitFor(() => expect(btn('Details...')).toBeTruthy());
  click('OK');
  await p;
  expect(s.project).toEqual(before);
  expect(s.stack.canUndo).toBe(false);
});

test('code mode garbage reply changes nothing', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const p = askAi(ide('code'), fakeBackend('m', async () => 'Beklager.'), { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(btn('Details...')).toBeTruthy());
  click('OK');
  await p;
  expect(w.applyChange).not.toHaveBeenCalled();
});

test('form mode happy path is one undo step', async () => {
  const s = ide('designer');
  const before = structuredClone(s.project);
  const reply = '{"ops":[{"op":"add","type":"Label","name":"lblHi","props":{"Caption":"Hi"}},{"op":"set","name":"Command1","props":{"Caption":"Go"}}],"code":"Private Sub Command1_Click()\\n    lblHi.Caption = \\"x\\"\\nEnd Sub"}';
  const p = askAi(s, fakeBackend('m', async () => reply), { codeWindowFor: () => null });
  await enterPrompt('add label');
  await vi.waitFor(() => expect(text()).toContain('Add Label lblHi'));
  click('OK');
  await p;
  const f = s.project.forms[0];
  expect(f.controls.map(c => c.name)).toEqual(['Command1', 'lblHi']);
  expect(f.controls[0].props.Caption).toBe('Go');
  expect(f.code).toContain('lblHi.Caption');
  s.stack.undo();
  expect(s.project).toEqual(before);
});

test('form preview Cancel leaves the project alone', async () => {
  const s = ide('designer');
  const p = askAi(s, fakeBackend('m', async () => '{"ops":[{"op":"delete","name":"Command1"}]}'), { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('Delete Command1'));
  click('Cancel');
  await p;
  expect(s.project.forms[0].controls).toHaveLength(1);
});

test('disabled during run', () => {
  const s = ide('designer');
  const item = () => buildMenus({ askAi: () => {} }, s).find(m => m.label === 'Tools')!.items.find(i => i.label === 'Ask AI...')!;
  expect(item().enabled!()).toBe(true);
  s.setMode('run');
  expect(item().enabled!()).toBe(false);
  s.setMode('break');
  expect(item().enabled!()).toBe(false);
});

test('form preview Code... button shows the proposed code', async () => {
  const s = ide('designer');
  const reply = '{"ops":[{"op":"set","name":"Command1","props":{"Caption":"Go"}}],"code":"Private Sub Command1_Click()\\n    MsgBox \\"x\\"\\nEnd Sub"}';
  const p = askAi(s, fakeBackend('m', async () => reply), { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(btn('Code...')).toBeTruthy());
  expect(btn('Code...')!.disabled).toBe(false);
  click('Code...');
  await vi.waitFor(() => expect(document.querySelector('.ai-after')?.textContent).toContain('MsgBox "x"'));
  click('Cancel');   // closes the code view only
  await vi.waitFor(() => expect(btn('Code...')).toBeTruthy());
  click('OK');
  await p;
  expect(s.project.forms[0].code).toContain('MsgBox "x"');
});

test('form preview Code... is disabled without code', async () => {
  const p = askAi(ide('designer'), fakeBackend('m', async () => '{"ops":[{"op":"delete","name":"Command1"}]}'), { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(btn('Code...')).toBeTruthy());
  expect(btn('Code...')!.disabled).toBe(true);
  click('Cancel');
  await p;
});

// ---- Change... (continue the conversation) ----
const CODE_A = '```vb\nPrivate Sub Command1_Click()\n    MsgBox "A"\nEnd Sub\n```';
const CODE_B = '```vb\nPrivate Sub Command1_Click()\n    MsgBox "B"\nEnd Sub\n```';
async function change(wish: string) {
  await vi.waitFor(() => expect(btn('Change...')).toBeTruthy());
  click('Change...');
  await vi.waitFor(() => expect(document.querySelector('.ai-change')).toBeTruthy());
  expect(text()).toContain('What should be changed?');
  (document.querySelector('.ai-change') as HTMLInputElement).value = wish;
  click('OK');
}

test('Change... sends the same prefix plus the wish; OK applies the second proposal', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const replies = [CODE_A, CODE_B];
  const b = fakeBackend('m', async () => replies.shift()!);
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('say hi');
  await change('say B instead');
  await vi.waitFor(() => expect(document.querySelector('.ai-after')?.textContent).toContain('MsgBox "B"'));
  click('OK');
  await p;
  const [first, second] = b.aiChat.mock.calls.map(c => c[3] as { role: string; content: string }[]);
  expect(second.slice(0, first.length)).toEqual(first);
  expect(second.slice(first.length).map(m => m.role)).toEqual(['assistant', 'user']);
  expect(second[second.length - 1].content).toContain('say B instead');
  expect(second[second.length - 1].content).not.toContain('Private Sub');
  expect(w.applyChange).toHaveBeenCalledTimes(1);
  expect(w.src).toContain('MsgBox "B"');
});

test('a Change... answer that is not understood returns to the first proposal', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const replies = [CODE_A, 'Sorry, no.'];
  const b = fakeBackend('m', async () => replies.shift()!);
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('say hi');
  await change('x');
  await vi.waitFor(() => expect(btn('Details...')).toBeTruthy());
  click('OK');
  await vi.waitFor(() => expect(document.querySelector('.ai-after')?.textContent).toContain('MsgBox "A"'));
  click('OK');
  await p;
  expect(w.src).toContain('MsgBox "A"');
});

test('Cancel in the Change... box returns to the same preview', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const b = fakeBackend('m', async () => CODE_A);
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('say hi');
  await vi.waitFor(() => expect(btn('Change...')).toBeTruthy());
  click('Change...');
  await vi.waitFor(() => expect(document.querySelector('.ai-change')).toBeTruthy());
  click('Cancel');
  await vi.waitFor(() => expect(document.querySelector('.ai-after')?.textContent).toContain('MsgBox "A"'));
  expect(b.aiChat).toHaveBeenCalledTimes(1);
  click('OK');
  await p;
  expect(w.src).toContain('MsgBox "A"');
});

test('trimConversation drops the oldest pairs but keeps system, first question and the last two messages', () => {
  const m = (role: 'system' | 'user' | 'assistant', content: string) => ({ role, content });
  const big = 'x'.repeat(13000);
  const msgs = [m('system', 's'), m('user', 'q'), m('assistant', big), m('user', 'c1'), m('assistant', big), m('user', 'c2'), m('assistant', big), m('user', 'c3')];
  const out = trimConversation(msgs, 24000);
  expect(out.map(x => x.content.slice(0, 2))).toEqual(['s', 'q', 'xx', 'c3']);
  expect(trimConversation(msgs, 100000)).toEqual(msgs);
});

test('the trim budget leaves out the system prompt and follows a known context; the wishes of dropped requests stay as one line', () => {
  const m = (role: 'system' | 'user' | 'assistant', content: string) => ({ role, content });
  const sys = 's'.repeat(25000);
  const short = [m('system', sys), m('user', 'q'), m('assistant', 'a1'), m('user', 'c1'), m('assistant', 'a2'), m('user', 'c2')];
  expect(trimConversation(short)).toEqual(short);
  expect(conversationBudget(undefined)).toBe(24000);
  expect(conversationBudget(262144)).toBe(393216);
  expect(conversationBudget(262144, 98304)).toBe(327680);
  expect(conversationBudget(32768, 65536)).toBe(32768);   // more than half the context: the prompt keeps half
  const big = 'x'.repeat(13000);
  const long = [m('system', sys), m('user', 'q'), m('assistant', big), m('user', 'Change your last answer: make it red\nAnswer with the complete result again.'),
    m('assistant', big), m('user', 'Your answer has these problems:\n- x'), m('assistant', big), m('user', 'c3')];
  const out = trimConversation(long, 24000);
  expect(out.map(x => x.content.slice(0, 2))).toEqual(['ss', 'q', 'xx', 'c3']);
  expect(out[3].content).toBe('c3\n(Earlier wishes in this conversation: make it red.)');
});

test('the 20-minute total limit is not retried as a transient error; a dropped connection or a stalled stream is', () => {
  expect(isTransientError('The AI server did not finish within 20 minutes.')).toBe(false);
  expect(isTransientError('The AI server did not answer within 90 seconds.')).toBe(true);
  expect(isTransientError('The AI server answered 503: busy')).toBe(true);
});
