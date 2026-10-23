// What the run session needs from the environment that shows form windows and dialogs.

import type { DirListing, NetApi, Volume } from '../backend/backend';
import type { FontValue } from '../model/types';
import type { FileDialogRequest } from './commonDialog';
import type { OpenedMedia } from './mediaSource';
import type { ClipboardApi } from './objects/globalObjects';
import type { FormSnapshot, FromWindow, ToWindow } from './protocol';

export interface FormWindow {
  send(m: ToWindow): void;
  onMessage(cb: (m: FromWindow) => void): void;
  close(): Promise<void>;
}

export interface FormHost {
  openForm(s: FormSnapshot, o: { modal: boolean }): Promise<FormWindow>;
  messageBox(o: { prompt: string; title: string; buttons: number }): Promise<number>;
  inputBox(o: { prompt: string; title: string; defaultText: string }): Promise<string>;
  /** CommonDialog.ShowOpen / ShowSave: the Mac file dialog, opened from the main window. The chosen path, null when cancelled. */
  fileDialog(o: FileDialogRequest): Promise<string | null>;
  /** CommonDialog.ShowColor / ShowFont: the Win98 colour and font dialogs. Null when cancelled. */
  colorDialog(o: { color: number }): Promise<number | null>;
  fontDialog(o: { font: FontValue }): Promise<FontValue | null>;
  /** DriveListBox / DirListBox / FileListBox: the volumes and folder contents, read by the main window (the same call in the IDE and in made apps). */
  listVolumes(): Promise<Volume[]>;
  listDir(path: string): Promise<DirListing>;
  /** MMControl / MediaPlayer, when the form windows are not this document: opens the file (a full path) so that the window reads
   *  it itself (MediaSrc is a token, never the bytes). Absent: the file is read here and shared as a Blob URL. Rejects with error
   *  53 when the file is missing. */
  openMedia?(fullPath: string, mime: string): Promise<OpenedMedia>;
  /** Inet and Winsock: the network calls, made by the main window. Absent: the controls raise errors. */
  net?(): NetApi;
  /** Clipboard: the system clipboard (text). Absent: the program keeps its own copy. */
  clipboard?(): ClipboardApi;
  /** 'ai' only in the IDE: break mode on the line, then the Ask AI flow. */
  runtimeErrorBox(o: { number: number; description: string; compile: boolean; mode: 'ide' | 'app'; title: string }): Promise<'end' | 'debug' | 'ai'>;
}
