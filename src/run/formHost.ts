// What the run session needs from the environment that shows form windows and dialogs.

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
  runtimeErrorBox(o: { number: number; description: string; compile: boolean; mode: 'ide' | 'app'; title: string }): Promise<'end' | 'debug'>;
}
