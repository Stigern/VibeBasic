// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { askAi } from '../../src/ai/askDialog';
import type { Backend } from '../../src/backend/backend';
import { IdeState } from '../../src/ide/ideState';
import { newControl, newProject } from '../../src/model/controls';

const fakeBackend = (replies: (string | Promise<string>)[], thinking?: string) => {
  let i = 0;
  return {
    loadSettings: async () => ({ baseUrl: 'http://x/v1', model: 'm', apiKey: '', ...(thinking ? { thinking } : {}) }),
    saveSettings: async () => {},
    aiListModels: async () => [],
    aiChat: vi.fn(async () => replies[Math.min(i++, replies.length - 1)]),
  } as unknown as Backend & { aiChat: ReturnType<typeof vi.fn> };
};
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.dlg98 button')].find(b => b.textContent === label);
const click = (label: string) => btn(label)!.click();
const text = () => [...document.querySelectorAll('.dlg98')].map(d => d.textContent).join('|');
async function enterPrompt(t: string) {
  await vi.waitFor(() => expect(btn('OK')).toBeTruthy());
  (document.querySelector('.ai-prompt') as HTMLTextAreaElement).value = t;
  click('OK');
}
const codeWin = (src: string) => {
  const w = { src, getSource: () => w.src, getCursorLine: () => 1, applyChange: vi.fn((a: number, b: number, t: string) => { w.src = w.src.slice(0, a) + t + w.src.slice(b); }) };
  return w;
};
function ide(view: 'code' | 'designer') {
  const s = new IdeState(newProject());
  const f = s.project.forms[0];
  f.code = 'Private Sub Command1_Click()\nEnd Sub';
  f.controls.push(newControl(f, 'CommandButton', { left: 100, top: 100 }, null));
  s.setActiveView(view === 'code' ? { kind: 'code', itemId: f.id } : { kind: 'designer', formId: f.id });
  return s;
}
afterEach(() => { document.body.innerHTML = ''; });

const GOOD = '```vb\nPrivate Sub Command1_Click()\n    MsgBox "Hi"\nEnd Sub\n```';
const BAD_SYNTAX = '```vb\nPrivate Sub Command1_Click()\n    If x Then\nEnd Sub\n```';

test('thinking level is passed to aiChat; server default sends nothing', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const b = fakeBackend([GOOD], 'low');
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b.aiChat.mock.calls[0][4]).toBe('low');
  click('Cancel');
  await p;
  const b2 = fakeBackend([GOOD], 'server');
  const p2 = askAi(ide('code'), b2, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b2.aiChat.mock.calls[0][4]).toBeUndefined();
  click('Cancel');
  await p2;
});

test('Form1_Load is fixed automatically, no retry, note shown', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const b = fakeBackend(['```vb\nPrivate Sub Form1_Load()\n    MsgBox "Hi"\nEnd Sub\n```']);
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('Renamed Form1_Load to Form_Load'));
  click('OK');
  await p;
  expect(b.aiChat).toHaveBeenCalledTimes(1);
  expect(w.src).toContain('Sub Form_Load()');
  expect(w.src).not.toContain('Form1_Load');
});

test('clean answer: no retry, no warnings', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const b = fakeBackend([GOOD]);
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(document.querySelector('.ai-warning')).toBeNull();
  click('OK');
  await p;
  expect(b.aiChat).toHaveBeenCalledTimes(1);
});

test('syntax error triggers exactly one retry and the fixed reply is used', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const b = fakeBackend([BAD_SYNTAX, GOOD]);
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  const msgs = b.aiChat.mock.calls[1][3];
  expect(msgs.at(-2)).toEqual({ role: 'assistant', content: BAD_SYNTAX });
  expect(msgs.at(-1).role).toBe('user');
  expect(msgs.at(-1).content).toMatch(/^Your answer has these problems:\n- Line \d+: .*\nFix them and answer again in exactly the same format\.$/);
  expect(document.querySelector('.ai-warning')).toBeNull();
  click('OK');
  await p;
  expect(w.src).toContain('MsgBox "Hi"');
});

test('unknown control event triggers a retry (form mode)', async () => {
  const s = ide('designer');
  const wrong = '{"ops":[],"code":"Private Sub Command7_Click()\\n    MsgBox 1\\nEnd Sub"}';
  const right = '{"ops":[],"code":"Private Sub Command1_Click()\\n    MsgBox 1\\nEnd Sub"}';
  const b = fakeBackend([wrong, right]);
  const p = askAi(s, b, { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(b.aiChat.mock.calls[1][3].at(-1).content).toContain('There is no control named Command7, so Command7_Click would never run.');
  click('OK');
  await p;
  expect(s.project.forms[0].code).toContain('Command1_Click');
});

test('controls added by the ops are known to the validator', async () => {
  const s = ide('designer');
  const reply = '{"ops":[{"op":"add","type":"Label","name":"lblHi","props":{"Left":2400,"Top":2400}}],"code":"Private Sub lblHi_Click()\\nEnd Sub"}';
  const b = fakeBackend([reply]);
  const p = askAi(s, b, { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('Add Label lblHi'));
  click('OK');
  await p;
  expect(b.aiChat).toHaveBeenCalledTimes(1);
});

test('still broken after the retry: warnings shown, nothing applied without OK', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const b = fakeBackend([BAD_SYNTAX, BAD_SYNTAX]);
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(document.querySelector('.ai-warning')!.textContent).toMatch(/^Line \d+: /);
  expect(w.applyChange).not.toHaveBeenCalled();
  click('Cancel');
  await p;
  expect(w.applyChange).not.toHaveBeenCalled();
});

test('retry reply that cannot be understood keeps the first answer', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  const b = fakeBackend([BAD_SYNTAX, 'Sorry.']);
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(document.querySelector('.ai-warning')).not.toBeNull();
  click('Cancel');
  await p;
});

test('cancel during the check round keeps the first proposal: it is previewed, and nothing is applied without OK', async () => {
  const w = codeWin('Private Sub Command1_Click()\nEnd Sub');
  let done!: (v: string) => void;
  const b = fakeBackend([BAD_SYNTAX, new Promise<string>(r => { done = r; })]);
  const p = askAi(ide('code'), b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('Checking and fixing...'));
  click('Cancel');
  await vi.waitFor(() => expect(document.querySelector('.ai-after')?.textContent).toContain('If x Then'));
  done(GOOD);   // the late answer of the cancelled round is discarded
  await new Promise(r => setTimeout(r, 20));
  expect(document.querySelector('.ai-after')?.textContent).not.toContain('MsgBox');
  click('Cancel');
  await p;
  expect(document.querySelector('.dlg98')).toBeNull();
  expect(w.applyChange).not.toHaveBeenCalled();
  expect(b.aiChat).toHaveBeenCalledTimes(2);
});

test('form mode: invalid JSON gets one retry and the second answer is used', async () => {
  const s = ide('designer');
  const broken = '{"ops":[{"op":"add","type":"Label","name":"lblHi",}';
  const right = '{"ops":[{"op":"add","type":"Label","name":"lblHi"}]}';
  const b = fakeBackend([broken, right]);
  const p = askAi(s, b, { codeWindowFor: () => null });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('Add Label lblHi'));
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  expect(b.aiChat.mock.calls[1][3].at(-1).content).toMatch(/^Your answer was not valid JSON \(.+\)\. Answer again with ONLY the JSON object\.$/);
  click('OK');
  await p;
  expect(s.project.forms[0].controls.some(c => c.name === 'lblHi')).toBe(true);
});

test('a reply that echoes a procedure without its body: the real one stays, and the one retry asks for the changed procedures only', async () => {
  const src = 'Private Sub Command1_Click()\nEnd Sub\n\nPrivate Sub Helper()\n    x = 1\nEnd Sub';
  const w = codeWin(src);
  const echo = "```vb\nPrivate Sub Command1_Click()\n    MsgBox \"Hi\"\nEnd Sub\n\nPrivate Sub Helper()\n' ... (body omitted)\nEnd Sub\n```";
  const b = fakeBackend([echo, GOOD]);
  const s = ide('code');
  s.project.forms[0].code = src;
  const p = askAi(s, b, { codeWindowFor: () => w as any });
  await enterPrompt('x');
  await vi.waitFor(() => expect(text()).toContain('AI Suggestion'));
  expect(b.aiChat).toHaveBeenCalledTimes(2);
  const retry = (b.aiChat.mock.calls[1][3] as { content: string }[]).at(-1)!.content;
  expect(retry).toContain('Helper');
  expect(retry).toContain('Send only the procedures you changed');
  click('OK');
  await p;
  expect(w.src).toContain('MsgBox "Hi"');
  expect(w.src).toContain('    x = 1');
});
