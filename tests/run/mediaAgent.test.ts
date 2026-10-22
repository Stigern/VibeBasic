// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { RunSession } from '../../src/run/session';

// A fake audio element: jsdom has no media playback. Every media element reports 1.5 s of metadata when loaded; play() and pause() work.
const media = HTMLMediaElement.prototype;
const saved = { load: media.load, play: media.play, pause: media.pause, duration: Object.getOwnPropertyDescriptor(media, 'duration') };
const played: string[] = [];

let container: HTMLElement;
let session: RunSession | undefined;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  media.load = function (this: HTMLMediaElement) { setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')), 5); };
  media.play = function (this: HTMLMediaElement) { played.push('play'); return Promise.resolve(); };
  media.pause = function () { played.push('pause'); };
  Object.defineProperty(media, 'duration', { configurable: true, get: () => 1.5 });
  played.length = 0;
  container = document.createElement('div'); document.body.appendChild(container);
});
afterEach(() => {
  if (session && session.state !== 'ended') session.end();
  session = undefined;
  document.body.innerHTML = '';
  Object.assign(media, { load: saved.load, play: saved.play, pause: saved.pause });
  if (saved.duration) Object.defineProperty(media, 'duration', saved.duration);
  vi.useRealTimers();
});

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][]) {
  const p = newProject();
  p.forms = [newForm('Form1', code)];
  p.startupForm = 'Form1';
  for (const [type, name, props] of controls) {
    const c = newControl(p.forms[0], type, { left: 120, top: 120 }, null);
    c.name = name; Object.assign(c.props, props ?? {});
    p.forms[0].controls.push(c);
  }
  p.components = ['MCI32.OCX', 'MSDXM.OCX', 'AGENTCTL.DLL'];
  const out: string[] = [];
  const files: string[] = [];
  session = new RunSession(p, new InlineFormHost(container), {
    debugPrint: t => { out.push(t); }, onBreak: async () => 'end', onEnded: () => {},
    readFile: async path => { files.push(path); if (!/\.(wav|mp3)$/.test(path)) throw new Error('ENOENT'); return new Uint8Array([82, 73, 70, 70]); },
    appPath: '/app',
  }, 'ide');
  void session.start();
  await vi.advanceTimersByTimeAsync(100);
  return { out, files };
}

test('MMControl: Open reads the file, Command "Play" sets Mode to mciModePlay; at the end Done(mciSuccessful) and Mode mciModeStop', async () => {
  const r = await run(`
Private Sub Form_Load()
  MMControl1.DeviceType = "WaveAudio"
  MMControl1.FileName = "tada.wav"
  MMControl1.Command = "Open"
  Debug.Print MMControl1.Mode; MMControl1.Length; MMControl1.Error
  MMControl1.Notify = True
  MMControl1.Command = "Play"
  Debug.Print MMControl1.Mode = mciModePlay
End Sub
Private Sub MMControl1_Done(NotifyCode As Integer)
  Debug.Print "done"; NotifyCode; MMControl1.Mode; MMControl1.Position
End Sub
`, [['MMControl', 'MMControl1']]);
  expect(r.files).toEqual(['/app/tada.wav']);
  expect(r.out).toEqual([' 525  1500  0 ', 'True']);
  expect(played).toContain('play');   // the window's element follows
  await vi.advanceTimersByTimeAsync(1600);
  expect(r.out.slice(2)).toEqual(['done 1  525  1500 ']);
});

test('MediaPlayer: Play and Pause raise PlayStateChange(OldState, NewState); EndOfStream at the end', async () => {
  const r = await run(`
Private Sub Form_Load()
  MediaPlayer1.FileName = "song.mp3"
  Debug.Print "dur"; MediaPlayer1.Duration; MediaPlayer1.PlayState
  MediaPlayer1.Play
  MediaPlayer1.Pause
  MediaPlayer1.Play
End Sub
Private Sub MediaPlayer1_PlayStateChange(ByVal OldState As Long, ByVal NewState As Long)
  Debug.Print "state"; OldState; NewState
End Sub
Private Sub MediaPlayer1_EndOfStream(ByVal Result As Long)
  Debug.Print "end"
End Sub
`, [['MediaPlayer', 'MediaPlayer1', { AutoStart: false }]]);
  expect(r.out).toEqual(['dur 1.5  0 ', 'state 0  2 ', 'state 2  1 ', 'state 1  2 ']);
  await vi.advanceTimersByTimeAsync(1600);
  expect(r.out.slice(4)).toEqual(['end', 'state 2  0 ']);
});

test('Agent: Speak then Play run one after the other and raise RequestComplete for each; the window draws the character', async () => {
  const r = await run(`
Dim Robby As Object, rs As Object, rp As Object
Private Sub Form_Load()
  Agent1.Characters.Load "Robby", "robby.acs"
  Set Robby = Agent1.Characters("Robby")
  Robby.Show True
  Set rs = Robby.Speak("Hello from 1998!")
  Set rp = Robby.Play("Wave")
  Debug.Print "queued"; rs.Status; rp.Status; rs.ID < rp.ID
End Sub
Private Sub Agent1_RequestComplete(ByVal Request As Object)
  If Request.ID <> rs.ID And Request.ID <> rp.ID Then Exit Sub   ' the Show
  Debug.Print "complete"; Request.ID = rs.ID; Request.ID = rp.ID; Request.Status
End Sub
`, [['Agent', 'Agent1']]);
  expect(r.out).toEqual(['queued 2  2 True']);
  const fig = container.querySelector<HTMLElement>('.ag-char[data-agent-id="Robby"]')!;
  expect(fig.querySelector('svg.ag-robby')).not.toBeNull();
  expect(fig.querySelector('.ag-balloon.shown')).not.toBeNull();   // speaking
  await vi.advanceTimersByTimeAsync(2500);   // the speech (no speech synthesis here: its time from the text length)
  expect(r.out.slice(1)).toEqual(['completeTrueFalse 0 ']);
  expect(fig.classList.contains('ag-a-wave')).toBe(true);
  await vi.advanceTimersByTimeAsync(1500);
  expect(r.out.slice(1)).toEqual(['completeTrueFalse 0 ', 'completeFalseTrue 0 ']);
});

test('Agent: Characters.Load with an unknown character is an error; the known ones load by name or file', async () => {
  const r = await run(`
Private Sub Form_Load()
  On Error Resume Next
  Agent1.Characters.Load "Clippy", "clippy.acs"
  Debug.Print Err.Number <> 0; Err.Description
  Err.Clear
  Agent1.Characters.Load "Helper", "C:\\WINDOWS\\MSAGENT\\CHARS\\Wizard.acs"
  Debug.Print Err.Number; Agent1.Characters("Helper").Name
End Sub
`, [['Agent', 'Agent1']]);
  expect(r.out).toEqual(['TrueThe character "clippy.acs" cannot be found. The known characters are Robby and Wizard', ' 0 Wizard']);
});
