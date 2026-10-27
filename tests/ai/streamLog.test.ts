// @vitest-environment jsdom
// The streamed text: each frame adds only what is new, and a fresh box gets everything again.
import { expect, test, vi } from 'vitest';
import { StreamLog } from '../../src/ai/streamLog';

const frame = () => new Promise(r => setTimeout(r, 40));

test('new text is appended to the same text node; earlier segments are left alone', async () => {
  const log = new StreamLog();
  const box = document.createElement('div');
  log.attach(box);
  log.add('reasoning', 'think');
  await frame();
  log.add('content', 'Hel');
  await frame();
  const thinking = box.querySelector('.ai-thinking')!.firstChild as Text;
  const answer = box.querySelector('.ai-answer')!.firstChild as Text;
  const read = vi.spyOn(thinking, 'data', 'get');
  log.add('content', 'lo');
  await frame();
  expect(box.querySelector('.ai-answer')!.firstChild).toBe(answer);
  expect(answer.data).toBe('\n\nHello');
  expect(read).not.toHaveBeenCalled();
  expect(box.textContent).toBe('think\n\nHello');

  const again = document.createElement('div');
  log.detach();
  log.separator();
  log.attach(again);
  expect(again.textContent).toBe(`think\n\nHello\n\n--- Checking and fixing ---\n\n`);
  log.add('content', 'x');
  await frame();
  expect(again.textContent).toBe(`think\n\nHello\n\n--- Checking and fixing ---\n\nx`);
});
