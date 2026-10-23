// Messages between the run session (main window) and a form window renderer.

import type { ControlDef, FormDef, PropValue } from '../model/types';

export interface FormSnapshot {
  key: string; form: FormDef;
  assets: Record<string, string>;                 // asset key -> data URL
  handled: Record<string, string[]>;              // control id / 'form' -> events that have code
  mode: 'ide' | 'app';
  /** What is drawn on the form and its PictureBoxes before the window opened (id / 'form' -> GfxOps). */
  gfx?: Record<string, string[]>;
  /** The CSS cursor Screen.MousePointer puts over every form window when the window opens. */
  cursor?: string;
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
  | { t: 'keyResult'; requestId: number; keyAscii: number }
  | { t: 'validated'; requestId: number; cancel: boolean }       // the Validate event ran: Cancel keeps the focus where it was
  | { t: 'cursor'; css: string }                                  // Screen.MousePointer / MouseIcon: '' = none
  | { t: 'drag'; id: string; action: number }                     // Ctl.Drag: 0 cancel, 1 begin (follows the mouse), 2 drop where the mouse is
  | { t: 'oleDrag'; id: string }                                  // Ctl.OLEDrag: an OLE drag from the control starts
  | { t: 'oleEffect'; effect: number }                           // the drop target's Effect (the drag cursor: none, copy, move)
  | { t: 'eventDone'; requestId: number }        // an event sent with a requestId (a menu's Click before it opens) has run
  // PopupMenu: show menu `id`'s items at (x, y) (client twips; null: at the mouse), `bold` the default item; answer with popupDone
  | { t: 'popup'; requestId: number; id: string; flags: number; x: number | null; y: number | null; bold: string | null }
  // MDI (to the MDI form's window, whose workspace shows the children; see mdiWorkspace.ts): a child opens / gets a message / closes,
  // the session's active child (null: none), Arrange
  | { t: 'mdiOpen'; snapshot: FormSnapshot }
  | { t: 'mdiTo'; key: string; m: ToWindow }
  | { t: 'mdiClose'; key: string }
  | { t: 'mdiActive'; key: string | null }
  | { t: 'mdiArrange'; arrangement: number };

export type FromWindow =
  | { t: 'ready' }
  | { t: 'event'; id: string | 'form'; event: string; args: (number | string)[]; state?: Record<string, PropValue>; requestId?: number }
  | { t: 'state'; id: string; props: Record<string, PropValue> }   // the user changed something that has no handler ('form': WindowState)
  | { t: 'focused'; id: string }                                   // a control got the focus and has no GotFocus code (Me.ActiveControl)
  | { t: 'closeRequest' }
  | { t: 'activated' }                                             // the user brought the form to the front (focus from outside it)
  | { t: 'resized'; width: number; height: number }                // twips
  | { t: 'moved'; left: number; top: number }                      // twips: the user moved the window
  | { t: 'popupDone'; requestId: number; id: string | null }       // the item chosen in a PopupMenu, or null (cancelled)
  | { t: 'mdiFrom'; key: string; m: FromWindow }                   // a message of MDI child `key` (shown in this window)
  | OleMessage;

/**
 * OLE drag and drop, in order (the session raises the events): `start` from a control of this form (`id`; an automatic TextBox drag
 * gives its selected text and the selection) or from Finder (`id` null, the paths); `over` a drop target (OLEDropMode 1 or 2) with
 * State vbEnter 0 / vbLeave 1 / vbOver 2; `drop` on a target, or `id` null when it ended elsewhere or was cancelled. X / Y are twips
 * from the target's origin; `at` is the character a text field was dropped on.
 */
export type OleMessage =
  | { t: 'ole'; phase: 'start'; id: string | null; auto?: boolean; text?: string; sel?: [number, number]; files?: string[] }
  | { t: 'ole'; phase: 'over'; id: string; state: number; x: number; y: number; button: number; shift: number }
  | { t: 'ole'; phase: 'drop'; id: string | null; x: number; y: number; button: number; shift: number; at?: number };
