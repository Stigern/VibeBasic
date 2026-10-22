// Microsoft Agent (AGENTCTL.DLL): what the run session (run/objects/agentControl.ts) and the window renderer (controls/agent.ts) share.
//
// The Agent control's prop `AgentChars` holds one JSON line (AgentCharState) per loaded character. The run session decides everything
// (positions, the animation playing, the balloon text, how long each takes); the window only draws it and reports the user's clicks
// and drags. Coordinates are pixels from the top left corner of the form's client area (the character floats inside the form window).

/** The built-in characters: the name given to Characters.Load (any case) -> the sprite drawn. */
export const AGENT_CHARACTERS: Record<string, { sprite: 'robby' | 'wizard'; name: string; description: string }> = {
  robby: { sprite: 'robby', name: 'Robby', description: 'Robby, a friendly robot from 1998' },
  wizard: { sprite: 'wizard', name: 'Wizard', description: 'A little wizard with a crooked hat' },
};

/** Size of a character in pixels (a 32 x 32 pixel figure drawn three times larger). */
export const AGENT_SIZE = 96;

/** The animations Play knows (canonical name -> milliseconds). Showing and Hiding are what Show and Hide play. */
export const AGENT_ANIMATIONS: Record<string, number> = {
  Greet: 1600, Wave: 1400, Think: 2000, Explain: 1600, Congratulate: 1800, Surprised: 1000, Idle: 1200,
  Showing: 600, Hiding: 600, GestureLeft: 1200, GestureRight: 1200, GestureUp: 1200, GestureDown: 1200,
  RestPose: 200, Blink: 300, Acknowledge: 800, Pleased: 1200, Sad: 1400,
};

export function animationName(name: string): string | undefined {
  const l = name.trim().toLowerCase();
  return Object.keys(AGENT_ANIMATIONS).find(k => k.toLowerCase() === l);
}

/** Speaking time for the balloon text (and the request when there is no speech synthesis). */
export function speakMs(text: string): number { return Math.max(1200, 600 + 65 * text.length); }

/** Speak text without Agent's \tags\ (\emp\, \pau=500\, \spd=150\ ...). */
export function plainSpeech(text: string): string { return text.replace(/\\[a-z]+(=[^\\]*)?\\/gi, '').replace(/\s+/g, ' ').trim(); }

export interface AgentCharState {
  id: string; sprite: string; x: number; y: number; visible: boolean;
  /** The animation playing ('' none) and its sequence number (a new one restarts it). */
  anim: string; seq: number;
  /** MoveTo: milliseconds the last change of x / y takes (0: at once). */
  moveMs: number;
  /** The balloon: its text, whether it shows, 'think' for a thought balloon, and its sequence number and speaking time. */
  text: string; balloon: boolean; think: boolean; textSeq: number; speakMs: number; speaking: boolean;
}

export function decodeAgentChars(lines: readonly string[]): AgentCharState[] {
  const out: AgentCharState[] = [];
  for (const l of lines) { try { out.push(JSON.parse(l) as AgentCharState); } catch { /* skip a broken line */ } }
  return out;
}
