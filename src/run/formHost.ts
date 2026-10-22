// What the run session needs from the environment that shows form windows and dialogs.

import type { DirListing, Volume } from '../backend/backend';
import type { FontValue } from '../model/types';
import type { FileDialogRequest } from './commonDialog';
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
  runtimeErrorBox(o: { number: number; description: string; compile: boolean; mode: 'ide' | 'app'; title: string }): Promise<'end' | 'debug'>;
}
