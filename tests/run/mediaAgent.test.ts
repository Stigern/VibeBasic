// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { newControl, newForm, newProject } from '../../src/model/controls';
import type { ControlType, PropValue } from '../../src/model/types';
import { InlineFormHost } from '../../src/run/inlineFormHost';
import { MEDIA_TOKEN, mediaElementUrl, mediaRef, setMediaLoader, type OpenedMedia } from '../../src/run/mediaSource';
import type { FormSnapshot, ToWindow } from '../../src/run/protocol';
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

async function run(code: string, controls: [Exclude<ControlType, 'Form'>, string, Record<string, PropValue>?][], host: InlineFormHost = new InlineFormHost(container)) {
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
  session = new RunSession(p, host, {
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

test('MMControl: Play with Notify and Wait still ends when the length is unknown: the window reports its element\'s end', async () => {
  Object.defineProperty(media, 'duration', { configurable: true, get: () => NaN });   // the probe cannot tell the length
  const r = await run(`
Private Sub Form_Load()
  MMControl1.FileName = "long.wav"
  MMControl1.Command = "Open"
  Debug.Print "len"; MMControl1.Length
End Sub
Private Sub Command1_Click()
  MMControl1.Notify = True
  MMControl1.Wait = True
  MMControl1.Command = "Play"
  Debug.Print "after wait"; MMControl1.Mode = mciModeStop
End Sub
Private Sub MMControl1_Done(NotifyCode As Integer)
  Debug.Print "done"; NotifyCode
End Sub
`, [['MMControl', 'MMControl1'], ['CommandButton', 'Command1']]);
  expect(r.out).toEqual(['len 0 ']);
  container.querySelector<HTMLElement>('.vb-btn')!.click();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(r.out).toEqual(['len 0 ']);   // no length, no end timer: only the element can tell
  container.querySelector('video')!.dispatchEvent(new Event('ended'));
  await vi.advanceTimersByTimeAsync(50);
  expect(r.out.slice(1)).toEqual(['done 1 ', 'after waitTrue']);
});

test('MediaPlayer: FileName with AutoStart plays (and returns); a length the window learns later lets the clock reach EndOfStream', async () => {
  Object.defineProperty(media, 'duration', { configurable: true, get: () => NaN });
  const r = await run(`
Private Sub Form_Load()
  MediaPlayer1.FileName = "song.mp3"
  Debug.Print "state"; MediaPlayer1.PlayState
End Sub
Private Sub MediaPlayer1_EndOfStream(ByVal Result As Long)
  Debug.Print "end"; MediaPlayer1.Duration
End Sub
`, [['MediaPlayer', 'MediaPlayer1']]);
  expect(r.out).toEqual(['state 2 ']);   // mpPlaying
  Object.defineProperty(media, 'duration', { configurable: true, get: () => 2 });
  container.querySelector('video')!.dispatchEvent(new Event('durationchange'));
  await vi.advanceTimersByTimeAsync(2100);
  expect(r.out.slice(1)).toEqual(['end 2 ']);
});

test('a form window of its own gets a token for the file, never the bytes; the file is closed with the control', async () => {
  const opened: string[] = [], released: string[] = [], patches: string[] = [];
  class TokenHost extends InlineFormHost {
    async openMedia(fullPath: string, mime: string): Promise<OpenedMedia> {
      opened.push(fullPath);
      return { src: mediaRef('t1', mime), bytes: async () => new Uint8Array([82, 73, 70, 70]), release: () => { released.push(fullPath); } };
    }
    override async openForm(s: FormSnapshot, o: { modal: boolean }) {
      const w = await super.openForm(s, o);
      return { ...w, send: (m: ToWindow) => { patches.push(JSON.stringify(m)); w.send(m); } };
    }
  }
  const url = vi.fn((b: Blob) => `blob:test/${b.size}`), revoke = vi.fn();
  Object.assign(URL, { createObjectURL: url, revokeObjectURL: revoke });
  setMediaLoader(async token => (token === 't1' ? new Uint8Array([1, 2, 3]) : Promise.reject(new Error('no'))));
  try {
    const r = await run(`
Private Sub Form_Load()
  MMControl1.FileName = "tada.wav"
  MMControl1.Command = "Open"
  Debug.Print MMControl1.Length; MMControl1.Error
End Sub
Private Sub Command1_Click()
  MMControl1.Command = "Close"
End Sub
`, [['MMControl', 'MMControl1'], ['CommandButton', 'Command1']], new TokenHost(container));
    expect(opened).toEqual(['/app/tada.wav']);
    expect(r.out).toEqual([' 1500  0 ']);
    expect(container.querySelector('video')!.getAttribute('src')).toBe('blob:test/3');   // the window read the file by the token
    container.querySelector<HTMLElement>('.vb-btn')!.click();
    await vi.advanceTimersByTimeAsync(50);
    expect(released).toEqual(['/app/tada.wav']);
    expect(revoke).toHaveBeenCalledWith('blob:test/3');
    expect(patches.join('\n')).not.toContain('data:');
    expect(await mediaElementUrl(`${MEDIA_TOKEN}nope:audio/wav`)).toBeNull();
  } finally {
    setMediaLoader(null);
    Object.assign(URL, { createObjectURL: undefined, revokeObjectURL: undefined });
  }
});

test('MMControl: an Open still loading when the program ends starts no status timer', async () => {
  await run(`
Private Sub Command1_Click()
  MMControl1.UpdateInterval = 100
  MMControl1.FileName = "tada.wav"
  MMControl1.Command = "Open"
End Sub
`, [['MMControl', 'MMControl1'], ['CommandButton', 'Command1']]);
  container.querySelector<HTMLElement>('.vb-btn')!.click();
  session!.end();
  await vi.advanceTimersByTimeAsync(1000);
  expect(vi.getTimerCount()).toBe(0);
});
