// Messages between the run session (main window) and a form window renderer.

import type { ControlDef, FormDef, PropValue } from '../model/types';

export interface FormSnapshot {
  key: string; form: FormDef;
  assets: Record<string, string>;                 // asset key -> data URL
  handled: Record<string, string[]>;              // control id / 'form' -> events that have code
  mode: 'ide' | 'app';
  /** What is drawn on the form and its PictureBoxes before the window opened (id / 'form' -> GfxOps). */
  gfx?: Record<string, string[]>;
}

export type ToWindow =
  | { t: 'patch'; id: string | 'form'; props: Record<string, PropValue> }
  | { t: 'patches'; items: { id: string | 'form'; props: Record<string, PropValue> }[] }   // one flush, several controls
  | { t: 'focus'; id: string }
  | { t: 'focusInitial' }                         // shown (after Form_Activate): the first control in tab order gets the focus
  | { t: 'addControl'; def: ControlDef; handled: string[] }   // Load Command1(i): a new element (in front of the others)
  | { t: 'removeControl'; id: string }                       // Unload Command1(i)
  | { t: 'show' } | { t: 'hide' }
  | { t: 'blocked'; blocked: boolean }            // modal form or break mode: ignore input
  | { t: 'keyResult'; requestId: number; keyAscii: number };

export type FromWindow =
  | { t: 'ready' }
  | { t: 'event'; id: string | 'form'; event: string; args: (number | string)[]; state?: Record<string, PropValue>; requestId?: number }
  | { t: 'state'; id: string; props: Record<string, PropValue> }   // the user changed something that has no handler
  | { t: 'focused'; id: string }                                   // a control got the focus and has no GotFocus code (Me.ActiveControl)
  | { t: 'closeRequest' }
  | { t: 'activated' }                                             // the user brought the form to the front (focus from outside it)
  | { t: 'resized'; width: number; height: number }                // twips
  | { t: 'moved'; left: number; top: number };                     // twips: the user moved the window
