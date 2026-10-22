// Agent (AGENTCTL.DLL) renderer. In the designer an icon, like the Timer. At run time the control's element holds a layer whose origin is
// the top left of the form's client area, above the other controls (the element itself lets clicks through); every loaded character (the prop `AgentChars`, see model/agent.ts)
// is a figure in it, with its speech balloon. The figures float inside the form window: a Tauri form window cannot be transparent here
// (that needs macOSPrivateApi), so there is no separate window for them.
//
// The user can click, double-click and drag a figure; the renderer fires `vbuseraction` { verb: 'click' | 'dblclick' | 'dragstart' |
// 'dragend', id, button, shift, x, y } on inputEl (formWindow.ts sends it to the run session as the state `UserAction`).

import { AGENT_ANIMATIONS, AGENT_SIZE, decodeAgentChars, type AgentCharState } from '../model/agent';
import { twipsToPx } from '../model/twips';
import { h } from '../ui98/dom';
import { AGENT_ICON, agentSvg } from './agentArt';
import type { Ctx, Renderer } from './render';

interface Fig { el: HTMLElement; balloon: HTMLElement; st: AgentCharState | null; seq: number; textSeq: number; reveal: ReturnType<typeof setInterval> | null; moveEnd: ReturnType<typeof setTimeout> | null }

const shiftBits = (e: MouseEvent): number => (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0);
const buttonOf = (e: MouseEvent): number => (e.button === 2 ? 2 : e.button === 1 ? 4 : 1);

export function agentControl(c: Ctx): Renderer {
  let layer: HTMLElement | null = null;
  const figs = new Map<string, Fig>();

  function fire(verb: string, id: string, e: MouseEvent, x: number, y: number): void {
    c.fire('vbuseraction', { verb, id, button: buttonOf(e), shift: shiftBits(e), x: Math.round(x), y: Math.round(y) });
  }

  function makeFig(id: string): Fig {
    const el = h('div', { class: 'ag-char', dataset: { agentId: id } });
    const balloon = h('div', { class: 'ag-balloon' });
    const fig: Fig = { el, balloon, st: null, seq: -1, textSeq: -1, reveal: null, moveEnd: null };
    el.appendChild(balloon);
    // a press starts a drag once the pointer has moved 3 pixels; without moving it is a click
    el.addEventListener('mousedown', e => {
      if (e.button !== 0 || (e.target as Element).closest('.ag-balloon')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, ox = el.offsetLeft, oy = el.offsetTop;
      let dragging = false;
      const move = (m: MouseEvent) => {
        if (!dragging && Math.hypot(m.clientX - sx, m.clientY - sy) < 3) return;
        if (!dragging) { dragging = true; el.style.transition = 'none'; fire('dragstart', id, e, ox, oy); }
        el.style.left = `${ox + m.clientX - sx}px`; el.style.top = `${oy + m.clientY - sy}px`;
      };
      const up = (u: MouseEvent) => {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        if (dragging) fire('dragend', id, u, el.offsetLeft, el.offsetTop);
        else fire('click', id, u, el.offsetLeft + (u.clientX - el.getBoundingClientRect().left), el.offsetTop + (u.clientY - el.getBoundingClientRect().top));
      };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    el.addEventListener('dblclick', e => fire('dblclick', id, e, el.offsetLeft, el.offsetTop));
    el.addEventListener('contextmenu', e => { e.preventDefault(); fire('click', id, e, el.offsetLeft, el.offsetTop); });
    return fig;
  }

  function showBalloon(f: Fig, st: AgentCharState): void {
    const on = st.balloon && st.text !== '';
    f.balloon.classList.toggle('shown', on);
    f.balloon.classList.toggle('think', st.think);
    f.balloon.classList.toggle('below', st.y < 60);
    // keep the balloon inside the form (it starts left of the figure), the tail under it pointing at the head
    const left = Math.max(-24, -st.x + 2);
    f.balloon.style.left = `${left}px`;
    f.balloon.style.setProperty('--tail', `${44 - left}px`);
    if (!on) { if (f.reveal) clearInterval(f.reveal); f.reveal = null; f.textSeq = -1; return; }
    if (st.textSeq === f.textSeq) return;
    f.textSeq = st.textSeq;
    // the words appear one by one over the speaking time, as Agent's balloon does
    const words = st.text.split(' ');
    let n = 0;
    if (f.reveal) clearInterval(f.reveal);
    const step = Math.max(40, Math.min(400, (st.speakMs * 0.85) / Math.max(1, words.length)));
    const show = () => { n++; f.balloon.textContent = words.slice(0, n).join(' '); if (n >= words.length && f.reveal) { clearInterval(f.reveal); f.reveal = null; } };
    show();
    if (n < words.length) f.reveal = setInterval(show, step);
  }

  function apply(f: Fig, st: AgentCharState): void {
    const old = f.st;
    if (!old || old.sprite !== st.sprite) {
      f.el.querySelector('svg')?.remove();
      f.el.insertAdjacentHTML('afterbegin', agentSvg(st.sprite, AGENT_SIZE));
    }
    f.el.style.display = st.visible ? '' : 'none';
    if (!old || old.x !== st.x || old.y !== st.y) {
      const ms = old && st.moveMs > 0 ? st.moveMs : 0;
      f.el.style.transition = ms ? `left ${ms}ms linear, top ${ms}ms linear` : 'none';
      f.el.style.left = `${st.x}px`; f.el.style.top = `${st.y}px`;
      if (f.moveEnd) clearTimeout(f.moveEnd);
      f.el.classList.toggle('ag-moving', ms > 0);
      if (ms) f.moveEnd = setTimeout(() => { f.el.classList.remove('ag-moving'); f.moveEnd = null; }, ms);
    }
    if (st.seq !== f.seq) {
      f.seq = st.seq;
      for (const k of [...f.el.classList]) if (k.startsWith('ag-a-')) f.el.classList.remove(k);
      if (st.anim) {
        void f.el.offsetWidth;   // restart the CSS animation
        f.el.style.setProperty('--ag-dur', `${AGENT_ANIMATIONS[st.anim] ?? 1000}ms`);
        f.el.classList.add(`ag-a-${st.anim.toLowerCase()}`);
      }
    }
    f.el.classList.toggle('ag-speaking', st.speaking);
    showBalloon(f, st);
    f.st = st;
  }

  return {
    build() {
      if (c.mode !== 'run') { c.el.innerHTML = AGENT_ICON; return; }
      layer = h('div', { class: 'ag-layer' });
      c.el.replaceChildren(layer);
      c.setInput(layer);
      figs.clear();
    },
    patch(k) {
      if (!layer) return;
      // the layer is at the client area's corner, whatever the control's own Left / Top
      layer.style.left = `${-twipsToPx(c.num('Left'))}px`; layer.style.top = `${-twipsToPx(c.num('Top'))}px`;
      if (k !== null && !k.has('AgentChars')) return;
      const states = decodeAgentChars(c.list('AgentChars'));
      const ids = new Set(states.map(s => s.id));
      for (const [id, f] of figs) if (!ids.has(id)) { if (f.reveal) clearInterval(f.reveal); f.el.remove(); figs.delete(id); }
      for (const st of states) {
        let f = figs.get(st.id);
        if (!f) { f = makeFig(st.id); figs.set(st.id, f); layer.appendChild(f.el); }
        apply(f, st);
      }
    },
    bg: () => null,
    overlay: true,
  };
}
