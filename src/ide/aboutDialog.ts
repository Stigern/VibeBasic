// Help > About VibeBasic: version, attribution and the rendered CHANGELOG.md.
import changelogRaw from '../../CHANGELOG.md?raw';
import { h } from '../ui98/dom';
import { showDialog98 } from '../ui98/dialogs';
import { osName } from '../platform';

/** The About box's text, naming the system it runs on. */
export const aboutText = (): string => `A Visual Basic 6 style programming environment for ${osName()}.\n\n`
  + "Pixel font 'MS Sans Serif' by lou (FontStruct), CC BY-SA 3.0\nWin98 look based on 98.css (MIT).";

/** Simple markdown subset: headings become bold lines, "- " bullets become "• " lines. */
export function renderChangelog(md: string): HTMLElement {
  const box = h('div', { class: 'about98-log', tabindex: '0', 'aria-readonly': 'true' });
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line === '') continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (heading) box.appendChild(h('div', { class: 'l b' }, heading[1]));
    else if (bullet) box.appendChild(h('div', { class: 'l' }, `• ${bullet[1]}`));
    else box.appendChild(h('div', { class: 'l' }, line));
  }
  return box;
}

export function showAbout(doc: Document): Promise<string> {
  const content = h('div', { class: 'about98' },
    h('div', { class: 'about98-title' }, 'VibeBasic'),
    h('div', {}, `Version ${__APP_VERSION__}`),
    h('div', { class: 'about98-text' }, aboutText()),
    h('div', {}, 'Changelog'),
    renderChangelog(changelogRaw));
  return showDialog98(doc, {
    title: 'About VibeBasic',
    content,
    buttons: [{ label: 'OK', value: 'ok', default: true, cancel: true }],
  });
}
