// MMControl (MCI32.OCX) and MediaPlayer (MSDXM.OCX): what the run session and the window renderers share.
//
// The run session owns the playback state (its own clock, see run/objects/mediaControls.ts). The window gets the file once as
// `MediaSrc` (a data URL) and the state as `MediaCmd` (MediaCommand as JSON); its media element follows that state.
import { MCI_BUTTONS } from './controls';
import type { PropValue } from './types';

export const MCI_MODE = { notOpen: 524, stop: 525, play: 526, record: 527, seek: 528, pause: 529, ready: 530 } as const;
export const MCI_NOTIFY = { successful: 1, superseded: 2, aborted: 4, failure: 8 } as const;
export const MP_STATE = { stopped: 0, paused: 1, playing: 2, closed: 6 } as const;

/** The state the window's media element follows. `seq` grows with every change; `pos` (ms) is where playing starts or stands,
 *  `to` where it stops (-1: the end), `length` the file's length (ms), `status` the MediaPlayer status line ("Playing" ...). */
export interface MediaCommand {
  seq: number; playing: boolean; pos: number; to: number; length: number; volume: number; muted: boolean; video: boolean; title: string; status: string;
}

export function encodeMediaCmd(c: MediaCommand): string { return JSON.stringify(c); }
export function decodeMediaCmd(s: string): MediaCommand | null {
  if (!s) return null;
  try { const v = JSON.parse(s) as MediaCommand; return typeof v.seq === 'number' ? v : null; } catch { return null; }
}

const MIME: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac',
  aif: 'audio/aiff', aiff: 'audio/aiff', mid: 'audio/midi', midi: 'audio/midi', rmi: 'audio/midi',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv',
};
const ext = (path: string): string => /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
export function mediaMime(path: string): string { return MIME[ext(path)] ?? 'application/octet-stream'; }
export function isVideoFile(path: string): boolean { return mediaMime(path).startsWith('video/'); }
/** MMControl: the device shows pictures (AVIVideo, MPEGVideo, DigitalVideo, or no DeviceType and a video file). */
export function mciIsVideo(deviceType: string, path: string): boolean {
  const d = deviceType.trim().toLowerCase();
  if (d === 'avivideo' || d === 'mpegvideo' || d === 'digitalvideo') return true;
  return d === '' && isVideoFile(path);
}
export function fileTitle(path: string): string { return path.split(/[\\/]/).pop() ?? path; }

/** MediaPlayer.Volume (hundredths of a dB, -10000 .. 0) as a gain 0 .. 1; -10000 is silence. */
export function volumeGain(v: number): number {
  if (v <= -10000) return 0;
  return Math.max(0, Math.min(1, 10 ** (Math.min(0, v) / 2000)));
}

// -- TimeFormat ----------------------------------------------------------------------------------------------------

/** Milliseconds in an MMControl TimeFormat: 1 Hms (0x00SSMMHH), 2 Msf (0x00FFSSMM, 75 frames a second), 3 Frames (30 a second),
 *  every other format as milliseconds. */
export function msToFormat(ms: number, format: number): number {
  const t = Math.max(0, Math.round(ms));
  const s = Math.floor(t / 1000);
  switch (format) {
    case 1: return (Math.floor(s / 3600) & 255) | ((Math.floor(s / 60) % 60) << 8) | ((s % 60) << 16);
    case 2: return (Math.floor(s / 60) & 255) | ((s % 60) << 8) | (Math.floor((t % 1000) * 75 / 1000) << 16);
    case 3: return Math.floor(t * 30 / 1000);
  }
  return t;
}
export function formatToMs(v: number, format: number): number {
  switch (format) {
    case 1: return ((v & 255) * 3600 + ((v >> 8) & 255) * 60 + ((v >> 16) & 255)) * 1000;
    case 2: return ((v & 255) * 60 + ((v >> 8) & 255)) * 1000 + Math.round(((v >> 16) & 255) * 1000 / 75);
    case 3: return Math.round(v * 1000 / 30);
  }
  return v;
}

// -- MMControl buttons ---------------------------------------------------------------------------------------------

export type MciButton = typeof MCI_BUTTONS[number];

/** Which buttons are enabled: with AutoEnable the device's Mode and abilities decide, otherwise the <Button>Enabled properties. */
export function mciEnabled(props: Record<string, PropValue>): Record<MciButton, boolean> {
  const out = {} as Record<MciButton, boolean>;
  const on = (k: string) => props[k] === true;
  if (props.AutoEnable === false || props.AutoEnable === 0) {
    for (const b of MCI_BUTTONS) out[b] = on(`${b}Enabled`);
    return out;
  }
  const mode = Number(props.Mode ?? MCI_MODE.notOpen);
  const open = mode !== MCI_MODE.notOpen, playing = mode === MCI_MODE.play, paused = mode === MCI_MODE.pause, step = on('CanStep');
  out.Prev = open; out.Next = open;
  out.Play = open && !playing && on('CanPlay');
  out.Pause = playing || paused;
  out.Back = open && step; out.Step = open && step;
  out.Stop = playing || paused;
  out.Record = open && on('CanRecord');
  out.Eject = open && on('CanEject');
  return out;
}

/** The MCI error texts of the errors the control sets. */
export const MCI_ERRORS: Record<number, string> = {
  263: 'The specified device is not open or is not recognized by MCI.',
  274: 'The MCI device the system is using does not support the specified command.',
  275: 'Cannot find the specified file. Make sure the path and filename are correct.',
  296: 'The specified file cannot be played on the specified MCI device. The file may be corrupt, not in the correct format, or no file handler available for this format.',
};
