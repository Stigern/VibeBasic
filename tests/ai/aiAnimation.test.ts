// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { createAiAnimation } from '../../src/ai/aiAnimation';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test('gives an element with an SVG in thinking phase, and setPhase flips the attribute and class', () => {
  const a = createAiAnimation(document);
  expect(a.el.querySelector('svg')?.getAttribute('shape-rendering')).toBe('crispEdges');
  expect(a.el.dataset.phase).toBe('thinking');
  a.setPhase('writing');
  expect(a.el.dataset.phase).toBe('writing');
  expect(a.el.classList.contains('ai-anim-writing')).toBe(true);
  a.setPhase('thinking');
  expect(a.el.classList.contains('ai-anim-writing')).toBe(false);
  a.dispose();
});

test('writing lights code lines and flies the sheets; thinking dims them; dispose stops the timer', () => {
  vi.useFakeTimers();
  const a = createAiAnimation(document);
  const lit = () => [...a.el.querySelectorAll('.ai-codeline')].filter(l => l.getAttribute('opacity') === '1').length;
  const sheet = () => a.el.querySelector('.ai-sheet')!.getAttribute('transform');
  expect(lit()).toBe(0);
  expect(vi.getTimerCount()).toBe(1);
  a.setPhase('writing');
  expect(lit()).toBe(1);
  const before = sheet();
  vi.advanceTimersByTime(90 * 3);
  expect(sheet()).not.toBe(before);
  vi.advanceTimersByTime(90 * 5);
  expect(lit()).toBeGreaterThan(1);
  a.setPhase('thinking');
  expect(lit()).toBe(0);
  a.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

test('prefers-reduced-motion gives a still picture without a timer', () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduced-motion'), addEventListener() {}, removeEventListener() {} }));
  const a = createAiAnimation(document);
  expect(vi.getTimerCount()).toBe(0);
  a.dispose();
});
