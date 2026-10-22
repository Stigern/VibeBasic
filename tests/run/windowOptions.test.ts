import { expect, test } from 'vitest';
import type { FormDef, PropValue } from '../../src/model/types';
import { windowOptionsFor } from '../../src/run/windowOptions';

const form = (props: Record<string, PropValue>): FormDef => ({ id: 'f', name: 'Form1', props, controls: [], code: '' });

test('size from twips', () => expect(windowOptionsFor(form({ Width: 4800, Height: 3600 }), 0)).toMatchObject({ width: 320, height: 240 }));
test('fixed dialog', () => expect(windowOptionsFor(form({ BorderStyle: 3 }), 0)).toMatchObject({ resizable: false, minimizable: false, maximizable: false }));
test('windows default cascades', () => expect(windowOptionsFor(form({ StartUpPosition: 3 }), 2)).toMatchObject({ center: false, x: 120, y: 120 }));
test('center screen', () => expect(windowOptionsFor(form({ StartUpPosition: 2 }), 0).center).toBe(true));
test('manual uses Left/Top; sizable resizes', () =>
  expect(windowOptionsFor(form({ StartUpPosition: 0, Left: 1500, Top: 750, BorderStyle: 2 }), 5)).toMatchObject({ center: false, x: 100, y: 50, resizable: true }));
