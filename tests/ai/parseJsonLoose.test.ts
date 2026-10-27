import { expect, test } from 'vitest';
import { parseFormOps } from '../../src/ai/formMode';
import { newForm } from '../../src/model/controls';

const ops = '{"ops":[{"op":"add","type":"CommandButton","name":"cmdOK","props":{"Caption":"OK"}}]}';
const parse = (reply: string) => parseFormOps(reply, newForm('Form1', ''));

test('brackets in the prose before the JSON do not spoil it', () => {
  expect(parse(`I will add a button [cmdOK]:\n\`\`\`json\n${ops}\n\`\`\``).ok).toBe(true);
});

test('braces in the prose after the JSON do not spoil it', () => {
  expect(parse(`\`\`\`json\n${ops}\n\`\`\`\nThis sets {Caption} to OK.`).ok).toBe(true);
});

test('an unclosed bracket in the prose before the JSON is not "cut off"', () => {
  expect(parse(`Press [ to start.\n${ops}`).ok).toBe(true);
});

test('a bare array of ops is accepted, and a cut-off answer is reported as cut off', () => {
  expect(parse(ops.slice(7, -1)).ok).toBe(true);
  const r = parse(ops.slice(0, 40));
  expect(r.ok).toBe(false);
  expect(!r.ok && r.reason).toMatch(/cut off/);
});
