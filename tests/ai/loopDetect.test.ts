import { expect, test } from 'vitest';
import { LoopWatch, findLoop } from '../../src/ai/loopDetect';
import { FORM_OPS_SCHEMA, MAX_OPS, parseFormOps } from '../../src/ai/formMode';
import { newProject } from '../../src/model/controls';

const OBSERVED = '{"op":"form","props":{"Caption":"Financial Manager","Width":4800,"Height":4800}},';

/** Feeds `text` to a watch in small deltas, as a stream does; the number of characters until it flagged, or null. */
function stream(text: string, kind: 'content' | 'reasoning' = 'content', step = 7): number | null {
  const w = new LoopWatch();
  for (let i = 0; i < text.length; i += step) if (w.add(kind, text.slice(i, i + step))) return i + step;
  return null;
}

test('the observed repeated op is a loop, also when the text ends inside the next copy', () => {
  const text = `{"ops":[{"op":"add","type":"ListBox","name":"lstTrans"},${OBSERVED.repeat(6)}{"op":"form","props":{"Cap`;
  expect(findLoop(text)).toMatchObject({ period: OBSERVED.length });
  expect(findLoop(text)!.repeats).toBeGreaterThanOrEqual(6);
  // in a stream it is caught within a few copies
  const at = stream(`{"ops":[${OBSERVED.repeat(200)}`);
  expect(at).not.toBeNull();
  expect(at!).toBeLessThan(OBSERVED.length * 15);
});

test('whitespace differences between the copies do not hide a loop; the thinking is watched too', () => {
  const block = 'I need to set the form caption to Financial Manager and the size to 4800.\n';
  expect(findLoop(block.repeat(3) + block.replace(/ /g, '  ').repeat(3))).not.toBeNull();
  expect(stream(block.repeat(60), 'reasoning')).not.toBeNull();
});

test('long blocks count from 3 repeats, short ones from 4', () => {
  const long = `{"op":"add","type":"TextBox","name":"txtAmount","props":{"Left":120,"Top":480,"Width":2400,"Height":315,"Text":"","ToolTipText":"The amount of the transaction"}},`.padEnd(220, ' ').replace(/ +$/, s => '_'.repeat(s.length));
  expect(long.length).toBeGreaterThanOrEqual(200);
  expect(findLoop('x'.concat(long.repeat(2)))).toBeNull();
  expect(findLoop('x'.concat(long.repeat(3)))).not.toBeNull();
  // a 70-character block needs 4 copies (and 256 characters)
  const short = OBSERVED.slice(0, 70);
  expect(findLoop(`x${short.repeat(3)}`)).toBeNull();
  expect(findLoop(`x${short.repeat(4)}`)).not.toBeNull();
});

test('no loop on 50 distinct add ops, AddItem lines, repeated End If or a row of = signs', () => {
  const ops = Array.from({ length: 50 }, (_, i) => `{"op":"add","type":"Label","name":"Label${i + 1}","props":{"Caption":"Item","Left":120,"Top":${120 + i * 360},"Width":1200,"Height":255}}`);
  const json = `{"ops":[${ops.join(',')}]}`;
  expect(findLoop(json)).toBeNull();
  expect(stream(json)).toBeNull();
  const items = Array.from({ length: 60 }, (_, i) => `    List1.AddItem "Transaction ${i + 1}"`).join('\n');
  expect(stream(items)).toBeNull();
  const ifs = `Private Sub Command1_Click()\n${'    If a Then\n        If b Then\n            x = 1\n'.repeat(1)}${'        End If\n'.repeat(40)}End Sub\n`;
  expect(stream(ifs)).toBeNull();
  expect(stream(`' ${'='.repeat(3000)}\n`)).toBeNull();
  const code = Array.from({ length: 80 }, (_, i) => `    If Val(Text${i}.Text) > 0 Then\n        Total = Total + Val(Text${i}.Text)\n    End If`).join('\n');
  expect(stream(code)).toBeNull();
});

test('a watch checks only every ~500 new characters and stays flagged', () => {
  const w = new LoopWatch();
  expect(w.add('content', OBSERVED.repeat(5))).toBe(false);   // under 500 characters: not checked yet
  expect(w.add('content', OBSERVED.repeat(2))).toBe(true);
  expect(w.looped).toBe('content');
  expect(w.add('content', 'anything')).toBe(true);
});

test('exact duplicate ops are dropped (the first counts) and the schema caps the ops', () => {
  const form = newProject().forms[0];
  const reply = JSON.stringify({ ops: [
    { op: 'add', type: 'ListBox', name: 'lstTrans' },
    { op: 'form', props: { Caption: 'Financial Manager', Width: 4800, Height: 4800 } },
    { op: 'form', props: { Caption: 'Financial Manager', Width: 4800, Height: 4800 } },
    { op: 'form', props: { Caption: 'Financial Manager', Width: 4800, Height: 4800 } },
    { op: 'add', type: 'Label', name: 'lblBalance' },
  ] });
  const r = parseFormOps(reply, form);
  if (!r.ok) throw new Error(r.reason);
  expect(r.ops.map(o => o.op)).toEqual(['add', 'form', 'add']);
  expect(r.warnings).toContain('Ignored 2 repeated operations (exact copies of an earlier one).');
  expect(FORM_OPS_SCHEMA.properties.ops.maxItems).toBe(MAX_OPS);
  expect(MAX_OPS).toBe(300);
});
