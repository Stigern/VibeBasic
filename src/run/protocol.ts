// Messages between the run session (main window) and a form window renderer.

import type { FormDef, PropValue } from '../model/types';

export interface FormSnapshot {
  key: string; form: FormDef;
  assets: Record<string, string>;                 // asset key -> data URL
  handled: Record<string, string[]>;              // control id / 'form' -> events that have code
  mode: 'ide' | 'app';
}

export type ToWindow =
  | { t: 'patch'; id: string | 'form'; props: Record<string, PropValue> }
  | { t: 'focus'; id: string }
  | { t: 'show' } | { t: 'hide' }
  | { t: 'blocked'; blocked: boolean }            // modal form or break mode: ignore input
  | { t: 'keyResult'; requestId: number; keyAscii: number };

export type FromWindow =
  | { t: 'ready' }
  | { t: 'event'; id: string | 'form'; event: string; args: (number | string)[]; state?: Record<string, PropValue>; requestId?: number }
  | { t: 'state'; id: string; props: Record<string, PropValue> }   // the user changed something that has no handler
  | { t: 'closeRequest' }
  | { t: 'resized'; width: number; height: number };               // twips
