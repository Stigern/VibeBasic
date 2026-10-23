// @vitest-environment jsdom
// 0.9 B1: the drawing statements and methods of Form and PictureBox (Print, PSet, Line, Circle, Scale, Point, Image ...).
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { Backend } from '../../src/backend/backend';
import { MemoryFs } from '../../src/lang/fileio/memoryFs';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, Project, PropValue } from '../../src/model/types';
import type { FormWindow } from '../../src/run/formHost';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import type { FormSnapshot, ToWindow } from '../../src/run/protocol';
import { RunSession } from '../../src/run/session';

type C = [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?];
function project(code: string, controls: C[] = []): Project {
  const p = newProject();
  const fd = newForm('Form1', code);
  for (const [type, name, props] of controls) {
    const c = newControl(fd, type, { left: 120, top: 120 }, null);
    c.name = name;
    Object.assign(c.props, props ?? {});
    fd.controls.push(c);
  }
  p.forms = [fd];
  p.startupForm = 'Form1';
  return p;
}

/** Records the snapshot and every message the form window gets. */
class RecordingHost extends InlineFormHost {
  snapshots: FormSnapshot[] = [];
  sent: ToWindow[] = [];
  override async openForm(s: FormSnapshot, o: { modal: boolean }): Promise<FormWindow> {
    this.snapshots.push(s);
    const w = await super.openForm(s, o);
    return { ...w, send: m => { this.sent.push(m); w.send(m); } };
  }
}

let container: HTMLElement;
let out: string[];
let session: RunSession | undefined;
let host: RecordingHost;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); out = []; });
afterEach(() => { if (session && session.state !== 'ended') session.end(); session = undefined; document.body.innerHTML = ''; });

async function run(code: string, controls: C[] = [], fs?: MemoryFs): Promise<RunSession> {
  host = new RecordingHost(container, fs as unknown as Backend | undefined);
  session = new RunSession(project(code, controls), host, {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async () => { throw new Error('ENOENT'); }, appPath: '/app',
  }, 'ide');
  await session.start();
  for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 0));
  return session;
}
const sub = (name: string, body: string) => `Private Sub ${name}()\n${body}\nEnd Sub\n`;
const PIXELS = 'ScaleMode = vbPixels\n';

test('Line with B draws the border (inside left alone), BF fills the box', async () => {
  await run(sub('Form_Load', `${PIXELS}Line (10, 10)-(20, 20), vbRed, B
Line (30, 10)-(40, 20), vbBlue, BF
Debug.Print Point(10, 10); Point(20, 15); Point(15, 15); Point(30, 10); Point(35, 15); Point(40, 20); Point(41, 20)`));
  expect(out[0].trim().split(/\s+/).map(Number)).toEqual([255, 255, 0xc0c0c0, 0xff0000, 0xff0000, 0xff0000, 0xc0c0c0]);
});

test('Circle arc: only the part from start to end (counter-clockwise), negative angles add the radius lines', async () => {
  await run(sub('Form_Load', `${PIXELS}Const PI = 3.14159265358979
Circle (50, 50), 20, vbRed, 0, PI / 2
Circle (150, 50), 20, vbBlue, -0.0001, -PI / 2
Debug.Print Point(70, 50); Point(50, 30); Point(30, 50); Point(50, 70); Point(64, 36)
Debug.Print Point(160, 50); Point(150, 40); Point(140, 50)`));
  expect(out[0].trim().split(/\s+/).map(Number)).toEqual([255, 255, 0xc0c0c0, 0xc0c0c0, 255]);
  expect(out[1].trim().split(/\s+/).map(Number)).toEqual([0xff0000, 0xff0000, 0xc0c0c0]);   // the pie's two radii
});

test('a loop of 10000 PSet is fast and reaches the window as ordered op lists, one per flush', async () => {
  const t0 = performance.now();
  await run(sub('Form_Click', `${PIXELS}For i = 0 To 9999: PSet (i Mod 100, i \\ 100), RGB(i Mod 256, 0, 0): Next
Debug.Print Point(99, 99) = RGB(9999 Mod 256, 0, 0)`));
  host.sent = [];
  container.querySelector<HTMLElement>('.vb-form-client')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 50 && !out.length; i++) await new Promise(r => setTimeout(r, 0));
  expect(out).toEqual(['True']);
  const ops = host.sent.flatMap(m => (m.t === 'patch' ? [m] : m.t === 'patches' ? m.items : []))
    .filter(p => p.id === 'form' && Array.isArray(p.props.GfxOps));
  expect(ops.length).toBeLessThan(10);
  expect(ops.flatMap(p => p.props.GfxOps as string[]).filter(o => o.includes('"pset"'))).toHaveLength(10000);
  expect(performance.now() - t0).toBeLessThan(1000);
});

test('Print: ; joins, , goes to the next 14-column zone, the line ends with CurrentY one text height down', async () => {
  await run(sub('Form_Load', `${PIXELS}Print "ab";
Debug.Print CurrentX = TextWidth("ab"); CurrentY
Print
Debug.Print CurrentX; CurrentY = TextHeight("A")
CurrentX = 0: CurrentY = 50
Print "a",;
z = CurrentX
Print "b"
Debug.Print z > TextWidth("a"); CurrentX; CurrentY = 50 + TextHeight("A")
CurrentX = 0
Print String(40, "W"),;
Debug.Print CurrentX = Int((TextWidth(String(40, "W")) / z) + 1) * z`));
  expect(out).toEqual(['True 0 ', ' 0 True', 'True 0 True', 'True']);
});

test('TextWidth and TextHeight measure in the Font and the ScaleMode', async () => {
  await run(sub('Form_Load', `Picture1.ScaleMode = vbPixels
Debug.Print TextHeight("A"); TextWidth(""); TextWidth("Hello") = 15 * Picture1.TextWidth("Hello"); TextWidth("Hello") > TextWidth("Hell")
Picture1.Font.Size = 16
Debug.Print Picture1.TextHeight("A" & vbCrLf & "B")`), [['PictureBox', 'Picture1']]);
  expect(out).toEqual([' 195  0 TrueTrue', ' 52 ']);   // MS Sans Serif 8: 13 px a line (VB6); 16 pt: 21.3 px * 1.2 = 26 px
});

test('ScaleMode 3: drawing, ScaleWidth and MouseDown X, Y are in pixels', async () => {
  await run(`${sub('Form_Load', `${PIXELS}PSet (10, 5), vbGreen
ScaleMode = vbTwips
Debug.Print Point(150, 75) = vbGreen; Point(10, 5) = vbGreen
ScaleMode = vbPixels
Debug.Print ScaleWidth = Width \\ 15 - 8`)}Private Sub Form_MouseDown(Button As Integer, Shift As Integer, X As Single, Y As Single)\nDebug.Print X; Y\nEnd Sub\n`);
  container.querySelector<HTMLElement>('.vb-form-client')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 30, clientY: 12 }));
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
  expect(out).toEqual(['TrueFalse', 'True', ' 30  12 ']);
});

test('Scale (x1, y1)-(x2, y2) sets a user scale (ScaleMode 0), Scale alone goes back to twips', async () => {
  await run(sub('Form_Load', `Scale (0, 100)-(100, 0)
Debug.Print ScaleMode; ScaleLeft; ScaleTop; ScaleWidth; ScaleHeight
DrawWidth = 3
PSet (10, 90), vbRed
ScaleMode = vbPixels
Debug.Print Point(ScaleWidth / 10, ScaleHeight / 10) = vbRed; Point(ScaleWidth / 10, ScaleHeight * 0.9) = vbRed
Scale
Debug.Print ScaleMode; ScaleLeft`));
  expect(out).toEqual([' 0  0  100  100 -100 ', 'TrueFalse', ' 1  0 ']);
});

test('Point returns the drawn colour, the BackColor where nothing is drawn, -1 outside', async () => {
  await run(sub('Form_Load', `Picture1.ScaleMode = vbPixels
Picture1.BackColor = vbWhite
Picture1.PSet (5, 5), vbRed
Debug.Print Picture1.Point(5, 5); Picture1.Point(6, 5); Picture1.Point(-1, 5); Picture1.Point(500, 5)
With Picture1
  .DrawMode = vbXorPen
  .Line (0, 2)-(9, 2), vbYellow
  .Line (0, 2)-(9, 2), vbYellow
End With
Debug.Print Picture1.Point(3, 2) = vbWhite`), [['PictureBox', 'Picture1']]);
  expect(out).toEqual([' 255  16777215 -1 -1 ', 'True']);
});

test('the Paint event fires when the form is shown (AutoRedraw False), not with AutoRedraw True', async () => {
  const code = `${sub('Form_Activate', 'Debug.Print "Activate"')}${sub('Form_Paint', 'Debug.Print "Paint"')}${sub('Picture1_Paint', 'Debug.Print "Picture1"')}`;
  await run(code, [['PictureBox', 'Picture1']]);
  expect(out).toEqual(['Activate', 'Paint', 'Picture1']);
  session!.end();
  out = [];
  await run(sub('Form_Load', 'AutoRedraw = True') + code, [['PictureBox', 'Picture1']]);
  expect(out).toEqual(['Activate', 'Picture1']);
});

test('AutoRedraw: what Form_Load draws is in the window when it opens, and Image returns it as a Picture', async () => {
  await run(sub('Form_Load', `Picture1.AutoRedraw = True
Picture1.ScaleMode = vbPixels
Picture1.Line (0, 0)-(9, 9), vbBlue, BF
Set Picture2.Picture = Picture1.Image
Debug.Print TypeName(Picture1.Image); Picture2.Picture.Handle <> 0`), [['PictureBox', 'Picture1'], ['PictureBox', 'Picture2']]);
  expect(out).toEqual(['PictureTrue']);
  const snap = host.snapshots[0];
  const id = snap.form.controls.find(c => c.name === 'Picture1')!.id;
  expect(snap.gfx?.[id]?.map(o => JSON.parse(o).o)).toEqual(['size', 'back', 'bits']);
  const pic = snap.form.controls.find(c => c.name === 'Picture2')!.props.Picture as { asset: string };
  expect(atob(pic.asset.replace(/^data:image\/png;base64,/, '')).slice(1, 4)).toBe('PNG');
});

test('SavePicture writes the Image as BMP (.bmp) or PNG through the file system', async () => {
  const fs = new MemoryFs();
  fs.mkdirs('/app');
  await run(sub('Form_Load', `Picture1.Line (0, 0)-(100, 100), vbRed, BF
SavePicture Picture1.Image, App.Path & "\\shot.bmp"
SavePicture Picture1.Image, App.Path & "\\shot.png"
Debug.Print "saved"`), [['PictureBox', 'Picture1']], fs);
  expect(out).toEqual(['saved']);
  const bmp = fs.readFile('/app/shot.bmp')!, png = fs.readFile('/app/shot.png')!;
  expect(bmp.slice(0, 2)).toBe('BM');
  expect(bmp.length).toBe(54 + ((77 * 3 + 3) & ~3) * 77);   // 1215 twips = 81 px, less the 2 px border on each side
  expect(png.slice(1, 4)).toBe('PNG');
});
