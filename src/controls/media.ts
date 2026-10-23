// MMControl (MCI32.OCX) and MediaPlayer (MSDXM.OCX) renderers.
//
// Both hold an HTML media element at run time that follows the props `MediaSrc` (which file: a token this window reads the file by,
// or a Blob URL of the run session's document; see run/mediaSource.ts) and `MediaCmd` (model/media.ts MediaCommand: play or stand
// at a position). The run session keeps the real state by its own clock; reported back are the user's clicks (`vbuseraction`
// { verb, pos? } on inputEl) and the element's end and length (`vbmediastate` { verb: 'ended' } / { verb: 'duration', ms }, so a
// Play whose length was unknown still ends); formWindow.ts sends both as the state `UserAction`. An MMControl showing video
// (AVIVideo) puts the picture in a small Win98 window over the form, as MCI's default display window does.

import { MCI_BUTTONS } from '../model/controls';
import { mediaElementUrl } from '../run/mediaSource';
import { decodeMediaCmd, mciEnabled, type MciButton, type MediaCommand } from '../model/media';
import { h } from '../ui98/dom';
import type { Ctx, Renderer } from './render';

// -- the media element ---------------------------------------------------------------------------------------------

/**
 * Keeps `el` in step with MediaSrc / MediaCmd. `report` gets the element's end and its length ({ verb: 'ended' } / { verb: 'duration',
 * ms }). The Blob URL made here for a file is revoked on the next file and on `destroy` (the control rebuilt or removed, the form closed).
 */
export function mediaFollower(el: HTMLMediaElement, report: (d: Record<string, string | number>) => void = () => {}) {
  let own: string | null = null, src = '', seq = -1, to = -1, gen = 0, ready = false;
  let last: MediaCommand | null = null;
  const drop = () => { if (own) URL.revokeObjectURL(own); own = null; };
  el.addEventListener('timeupdate', () => { if (to >= 0 && el.currentTime * 1000 >= to && !el.paused) el.pause(); });
  el.addEventListener('ended', () => { if (src) report({ verb: 'ended' }); });
  const length = () => { const d = el.duration; if (src && Number.isFinite(d) && d > 0) report({ verb: 'duration', ms: Math.round(d * 1000) }); };
  el.addEventListener('durationchange', length);
  el.addEventListener('loadedmetadata', length);
  const apply = (c: MediaCommand): void => {
    el.volume = Math.max(0, Math.min(1, c.volume));
    el.muted = c.muted;
    const want = c.pos / 1000;
    if (Math.abs((el.currentTime || 0) - want) > 0.3) { try { el.currentTime = want; } catch { /* not seekable yet */ } }
    if (c.playing) { const p = el.play() as Promise<void> | undefined; p?.catch?.(() => { /* a format the WebView cannot play */ }); }
    else if (!el.paused) el.pause();
  };
  return {
    src(data: string): void {
      if (data === src) return;
      src = data;
      seq = -1;
      const g = ++gen;
      ready = false;
      drop();
      if (!data) { el.removeAttribute('src'); return; }
      void mediaElementUrl(data).then(r => {
        if (g !== gen) { if (r?.own) URL.revokeObjectURL(r.url); return; }   // another file (or none) meanwhile
        if (!r) { el.removeAttribute('src'); return; }
        if (r.own) own = r.url;
        el.src = r.url;
        ready = true;
        if (last) { seq = last.seq; to = last.to; apply(last); }   // a command that came while the file was loading
      });
    },
    cmd(c: MediaCommand | null): void {
      if (!c || c.seq === seq || !src) return;
      last = c;
      if (!ready) return;   // the file is still loading: applied when it is there
      seq = c.seq; to = c.to;
      apply(c);
    },
    get current(): number { return (el.currentTime || 0) * 1000; },
    destroy(): void { gen++; ready = false; drop(); el.removeAttribute('src'); },
  };
}

const NS = 'http://www.w3.org/2000/svg';
function glyph(w: number, ht: number, body: string, off = false): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${ht}`);
  svg.setAttribute('width', String(w)); svg.setAttribute('height', String(ht));
  svg.setAttribute('shape-rendering', 'crispEdges');
  // a disabled glyph is etched: white, then grey one pixel up and left (the Win98 look)
  svg.innerHTML = off ? `<g fill="#fff" transform="translate(1 1)">${body}</g><g fill="#808080">${body}</g>` : `<g fill="#000">${body}</g>`;
  return svg;
}

// -- MMControl -----------------------------------------------------------------------------------------------------

const MCI_GLYPHS: Record<MciButton, string> = {
  Prev: '<rect x="2" y="2" width="2" height="7"/><path d="M9 2v7L5 5.5zM13 2v7L9 5.5z"/>',
  Next: '<path d="M2 2v7l4-3.5zM6 2v7l4-3.5z"/><rect x="11" y="2" width="2" height="7"/>',
  Play: '<path d="M5 1v9l5-4.5z"/>',
  Pause: '<rect x="4" y="2" width="2" height="7"/><rect x="9" y="2" width="2" height="7"/>',
  Back: '<rect x="3" y="2" width="2" height="7"/><path d="M10 2v7L6 5.5z"/>',
  Step: '<path d="M5 2v7l4-3.5z"/><rect x="10" y="2" width="2" height="7"/>',
  Stop: '<rect x="4" y="2" width="7" height="7"/>',
  Record: '<path d="M6 2h3v1h1v1h1v3h-1v1h-1v1H6V8H5V7H4V4h1V3h1z"/>',
  Eject: '<path d="M7.5 1L12 6H3z"/><rect x="3" y="7" width="9" height="2"/>',
};

export function mmControl(c: Ctx): Renderer {
  let root: HTMLElement, media: HTMLVideoElement | null = null, follow: ReturnType<typeof mediaFollower> | null = null;
  let popup: HTMLElement | null = null;

  function buttons(): void {
    const on = mciEnabled(c.props);
    const vert = c.num('Orientation') === 1;
    root.classList.toggle('vert', vert);
    root.replaceChildren(...MCI_BUTTONS.filter(b => c.bool(`${b}Visible`)).map(b => {
      const off = !on[b] || !c.bool('Enabled');
      const btn = h('div', { class: `mci-btn${off ? ' off' : ''}`, dataset: { button: b }, title: c.mode === 'run' ? b : null });
      btn.appendChild(glyph(15, 11, MCI_GLYPHS[b], off));
      return btn;
    }));
    c.el.classList.toggle('vb-bordered', c.num('BorderStyle') === 1);
  }

  /** The display window of a video device: over the form's client area, sized to the picture. */
  function showPopup(cmd: MediaCommand | null): void {
    const want = !!cmd?.video && c.str('MediaSrc') !== '';
    if (!want) { if (popup && media) { root.after(media); media.classList.remove('shown'); } popup?.remove(); popup = null; return; }
    const host = c.el.closest('.vb-form-client');
    if (!host || !media) return;
    if (!popup) {
      popup = h('div', { class: 'vb-mci-popup window' },
        h('div', { class: 'title-bar' }, h('div', { class: 'title-bar-text' }, cmd!.title)),
        h('div', { class: 'vb-mci-screen' }));
      popup.querySelector('.vb-mci-screen')!.appendChild(media);
      media.classList.add('shown');
      host.appendChild(popup);
    }
  }

  return {
    build() {
      root = h('div', { class: 'vb-mci' });
      c.el.replaceChildren(root);
      if (c.mode !== 'run') return;
      c.setInput(root);
      media = h('video', { class: 'vb-mci-media', playsinline: true }) as HTMLVideoElement;
      c.el.appendChild(media);
      follow?.destroy();
      follow = mediaFollower(media, d => c.fire('vbmediastate', d));
      root.addEventListener('click', e => {
        const b = (e.target as Element).closest<HTMLElement>('.mci-btn');
        if (b && !b.classList.contains('off') && root.getAttribute('aria-disabled') !== 'true') c.fire('vbuseraction', { verb: b.dataset.button });
      });
    },
    patch(k) {
      if (k === null || [...k].some(n => n.endsWith('Visible') || n.endsWith('Enabled') || ['Mode', 'AutoEnable', 'Orientation', 'BorderStyle', 'CanPlay', 'CanStep', 'CanRecord', 'CanEject'].includes(n))) buttons();
      if (!follow) return;
      if (k === null || k.has('MediaSrc')) follow.src(c.str('MediaSrc'));
      if (k === null || k.has('MediaCmd') || k.has('MediaSrc')) {
        const cmd = decodeMediaCmd(c.str('MediaCmd'));
        follow.cmd(cmd);
        if (k === null) setTimeout(() => showPopup(cmd), 0);   // the first render happens before the control is on the form
        else showPopup(cmd);
      }
    },
    destroy() { follow?.destroy(); follow = null; popup?.remove(); popup = null; },
    bg: () => null,
  };
}

// -- MediaPlayer ---------------------------------------------------------------------------------------------------

const MP_GLYPHS: Record<string, string> = {
  play: '<path d="M5 2v9l5-4.5z"/>',
  pause: '<rect x="4" y="2" width="2" height="9"/><rect x="8" y="2" width="2" height="9"/>',
  stop: '<rect x="4" y="3" width="7" height="7"/>',
  skipback: '<rect x="2" y="3" width="1" height="7"/><path d="M7 3v7L3 6.5zM11 3v7L7 6.5z"/>',
  rewind: '<path d="M7 3v7L3 6.5zM11 3v7L7 6.5z"/>',
  forward: '<path d="M3 3v7l4-3.5zM7 3v7l4-3.5z"/>',
  skipfwd: '<path d="M2 3v7l4-3.5zM6 3v7l4-3.5z"/><rect x="11" y="3" width="1" height="7"/>',
  mute: '<path d="M2 5h2l3-3v9L4 8H2z"/><path d="M9 4h1v1H9zM10 5h1v3h-1zM9 8h1v1H9z"/>',
  muted: '<path d="M2 5h2l3-3v9L4 8H2z"/><path d="M9 4l3 5M12 4l-3 5" stroke="#000" fill="none"/>',
};

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function mediaPlayer(c: Ctx): Renderer {
  let display: HTMLElement, bar: HTMLElement, status: HTMLElement, thumb: HTMLElement | null = null, time: HTMLElement | null = null;
  let follow: ReturnType<typeof mediaFollower> | null = null;
  let cmd: MediaCommand | null = null;

  const length = (): number => cmd?.length ?? 0;
  function tick(): void {
    const pos = follow ? follow.current : 0, len = length();
    if (thumb) thumb.style.left = `calc(${len > 0 ? Math.min(100, (pos / len) * 100) : 0}% - ${len > 0 ? Math.round(Math.min(1, pos / len) * 11) : 0}px)`;
    if (time) time.textContent = `${clock(pos)} / ${clock(len)}`;
  }

  function layout(): void {
    const controls = c.bool('ShowControls');
    bar.replaceChildren();
    bar.style.display = controls ? '' : 'none';
    if (controls) {
      if (c.bool('ShowTracker')) {
        thumb = h('div', { class: 'mp-thumb' });
        bar.appendChild(h('div', { class: 'mp-tracker', dataset: { verb: 'seek' } }, h('div', { class: 'mp-groove' }), thumb));
      } else thumb = null;
      const btn = (verb: string, g = verb) => { const b = h('div', { class: 'mp-btn', dataset: { verb }, title: c.mode === 'run' ? verb : null }); b.appendChild(glyph(14, 13, MP_GLYPHS[g])); return b; };
      const row = h('div', { class: 'mp-row' }, btn('play'), btn('pause'), btn('stop'));
      if (c.bool('ShowPositionControls')) row.append(h('div', { class: 'mp-sep' }), btn('skipback'), btn('rewind'), btn('forward'), btn('skipfwd'));
      row.append(h('div', { class: 'mp-fill' }), btn('mute', c.bool('Mute') ? 'muted' : 'mute'));
      bar.appendChild(row);
    }
    status.style.display = c.bool('ShowStatusBar') ? '' : 'none';
    time = h('div', { class: 'mp-time' });
    status.replaceChildren(h('div', { class: 'mp-status-text' }, cmd?.status || (c.mode === 'run' ? '' : 'Ready')), time);
    tick();
  }

  return {
    structural: ['ShowControls', 'ShowTracker', 'ShowPositionControls', 'ShowStatusBar'],
    build() {
      display = h('div', { class: 'mp-display' });
      bar = h('div', { class: 'mp-bar' });
      status = h('div', { class: 'mp-status' });
      const root = h('div', { class: 'vb-mp' }, display, bar, status);
      c.el.replaceChildren(root);
      if (c.mode === 'run') {
        c.setInput(root);
        const video = h('video', { class: 'mp-video', playsinline: true }) as HTMLVideoElement;
        display.appendChild(video);
        follow?.destroy();   // a rebuild (ShowControls ...): the old element's Blob URL goes
        follow = mediaFollower(video, d => c.fire('vbmediastate', d));
        follow.src(c.str('MediaSrc'));
        video.addEventListener('timeupdate', tick);
        root.addEventListener('click', e => {
          const t = (e.target as Element).closest<HTMLElement>('[data-verb]');
          if (!t || root.getAttribute('aria-disabled') === 'true') return;
          const verb = t.dataset.verb!;
          if (verb === 'seek') {
            const r = t.getBoundingClientRect();
            const f = r.width > 0 ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0;
            c.fire('vbuseraction', { verb, pos: Math.round(f * length()) });
          } else c.fire('vbuseraction', { verb, pos: Math.round(follow?.current ?? 0) });
        });
      }
      layout();
    },
    patch(k) {
      if (follow && (k === null || k.has('MediaSrc'))) follow.src(c.str('MediaSrc'));
      if (k === null || k.has('MediaCmd') || k.has('MediaSrc')) {
        cmd = decodeMediaCmd(c.str('MediaCmd'));
        follow?.cmd(cmd);
        const st = status.querySelector('.mp-status-text');
        if (st) st.textContent = cmd?.status ?? '';
        tick();
      }
      if (k?.has('Mute')) layout();
    },
    destroy() { follow?.destroy(); follow = null; },
    bg: () => null,
  };
}
