// Dev gallery: every control type, in design mode (grid, inert) and run mode (interactive), with a few
// property variations. Open http://localhost:1420/dev/gallery.html while `npm run dev` is running.
import { renderFormSurface, type AssetResolver } from '../controls/render';
import { CONTROL_TYPES } from '../model/controls';
import type { ControlDef, FontValue, FormDef, PropValue } from '../model/types';
import { h } from '../ui98/dom';
import '../ui98/theme.css';

const svg = (body: string, w: number, hh: number) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}">${body}</svg>`);
const PICTURES: Record<string, string> = {
  smiley: svg('<circle cx="12" cy="12" r="10" fill="#ff0" stroke="#000"/><circle cx="8" cy="9" r="1.5"/><circle cx="16" cy="9" r="1.5"/><path d="M7 14q5 6 10 0" fill="none" stroke="#000"/>', 24, 24),
  stripes: svg('<rect width="120" height="120" fill="#fff"/><path d="M0 0h20v120H0zM40 0h20v120H40zM80 0h20v120H80z" fill="#008080"/><circle cx="60" cy="60" r="30" fill="#800000"/>', 120, 120),
};
const assets: AssetResolver = ref => PICTURES[ref.asset] ?? null;

let counter = 0;
const px = (n: number) => n * 15;
const font = (name: string, size: number, o: Partial<FontValue> = {}): FontValue => ({ name, size, bold: false, italic: false, underline: false, ...o });

/** A control from the registry defaults; position and size in pixels (as drawn on screen), converted to twips. */
function c(type: ControlDef['type'], name: string, x: number, y: number, w: number, hgt: number,
  props: Record<string, PropValue> = {}, parentId: string | null = null): ControlDef {
  const p: Record<string, PropValue> = {};
  for (const pd of CONTROL_TYPES[type].props) if (pd.designTime) p[pd.name] = Array.isArray(pd.default) ? [] : pd.default;
  Object.assign(p, { Left: px(x), Top: px(y) });
  if ('Width' in p) Object.assign(p, { Width: px(w), Height: px(hgt) });
  if ('Caption' in p) p.Caption = name;
  if ('TabIndex' in p) p.TabIndex = counter;
  Object.assign(p, props);
  return { id: name, type, name, index: null, parentId, props: p };
}

function galleryForm(): FormDef {
  const items = ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry', 'Fig', 'Grape', 'Honeydew'];
  // Frame1's children are listed BEFORE the frame: the renderer builds the tree by parentId, not by array order.
  const controls: ControlDef[] = [
    c('OptionButton', 'Option4', 8, 22, 100, 17, { Value: true }, 'Frame1'),
    c('OptionButton', 'Option5', 8, 42, 100, 17, {}, 'Frame1'),
    c('CommandButton', 'Command5', 8, 66, 85, 25, { Caption: 'In frame' }, 'Frame1'),
    c('Label', 'Label7', 8, 8, 60, 17, { Caption: 'In picture', BackStyle: 0 }, 'Picture1'),
    c('Frame', 'Frame1', 8, 176, 200, 110, { Caption: 'Frame1' }),

    // row A: buttons, timer, scroll bar
    c('CommandButton', 'Command1', 8, 8, 85, 25),
    c('CommandButton', 'Command2', 100, 8, 85, 25, { Caption: '&OK', Default: true }),
    c('CommandButton', 'Command3', 192, 8, 85, 25, { Caption: 'Disabled', Enabled: false }),
    c('CommandButton', 'Command4', 284, 8, 85, 25, { Caption: 'Graphical', Style: 1, BackColor: 0x80ffff, Picture: { asset: 'smiley' } }),
    c('Timer', 'Timer1', 380, 8, 0, 0, { Interval: 1000 }),
    c('HScrollBar', 'HScroll1', 420, 12, 200, 17, { Min: 0, Max: 100, Value: 40, SmallChange: 5, LargeChange: 20 }),

    // row B: labels
    c('Label', 'Label1', 8, 42, 90, 17),
    c('Label', 'Label2', 104, 42, 90, 17, { Caption: 'Centered', Alignment: 2, BorderStyle: 1 }),
    c('Label', 'Label3', 200, 42, 90, 17, { Caption: 'Right', Alignment: 1, BorderStyle: 1, BackColor: 0x00ffff, ForeColor: 0xff0000 }),
    c('Label', 'Label4', 296, 42, 90, 17, { Caption: 'Transparent', BackStyle: 0, ForeColor: 0x0000ff }),
    c('Label', 'Label5', 392, 38, 100, 17, { Caption: 'AutoSize &Label', AutoSize: true, Font: font('Times New Roman', 12, { bold: true, italic: true, underline: true }) }),
    c('Label', 'Label6', 520, 38, 100, 28, { Caption: 'WordWrap label that wraps onto several lines', WordWrap: true }),

    // row C: text boxes
    c('TextBox', 'Text1', 8, 68, 90, 21),
    c('TextBox', 'Text2', 104, 68, 90, 21, { Text: 'secret', PasswordChar: '*' }),
    c('TextBox', 'Text3', 200, 68, 90, 21, { Text: 'Disabled', Enabled: false }),
    c('TextBox', 'Text4', 296, 68, 90, 21, { Text: 'Colours', BackColor: 0x000000, ForeColor: 0x00ff00 }),
    c('TextBox', 'Text5', 392, 68, 90, 21, { Text: 'Right, locked', Alignment: 1, Locked: true }),
    c('TextBox', 'Text6', 8, 96, 200, 70, {
      Text: 'MultiLine TextBox\r\nwith both scroll bars.\r\nLine 3\r\nLine 4\r\nLine 5 is a rather long line that needs horizontal scrolling to be read.',
      MultiLine: true, ScrollBars: 3,
    }),

    // check boxes and option buttons
    c('CheckBox', 'Check1', 220, 96, 100, 17),
    c('CheckBox', 'Check2', 220, 114, 100, 17, { Value: 1 }),
    c('CheckBox', 'Check3', 220, 132, 100, 17, { Value: 2 }),
    c('CheckBox', 'Check4', 220, 150, 100, 17, { Value: 1, Alignment: 1, Caption: 'Right aligned' }),
    c('CheckBox', 'Check5', 330, 96, 100, 17, { Value: 1, Enabled: false }),
    c('OptionButton', 'Option1', 330, 114, 100, 17, { Value: true }),
    c('OptionButton', 'Option2', 330, 132, 100, 17),
    c('OptionButton', 'Option3', 330, 150, 100, 17, { Enabled: false }),
    c('VScrollBar', 'VScroll1', 440, 96, 17, 70, { Min: 0, Max: 100, Value: 30, LargeChange: 20 }),

    // lists, combos, picture box, image
    c('ListBox', 'List1', 220, 176, 110, 70, { List: items, MultiSelect: 2 }),
    c('ComboBox', 'Combo1', 340, 176, 120, 21, { Text: 'Dropdown Combo', List: items }),
    c('ComboBox', 'Combo2', 340, 206, 120, 21, { Style: 2, Text: 'Dropdown List', List: items }),
    c('ComboBox', 'Combo3', 340, 236, 120, 60, { Style: 1, Text: 'Simple', List: items }),
    c('PictureBox', 'Picture1', 470, 176, 100, 80, { Picture: { asset: 'stripes' } }),
    c('Image', 'Image1', 580, 176, 40, 40, { Picture: { asset: 'smiley' }, Stretch: true, BorderStyle: 1 }),
    c('Image', 'Image2', 580, 224, 40, 40, {}),

    // progress bars
    c('ProgressBar', 'ProgressBar1', 8, 300, 200, 17, { Value: 60 }),
    c('ProgressBar', 'ProgressBar2', 8, 324, 200, 17, { Value: 60, Scrolling: 1 }),
    c('ProgressBar', 'ProgressBar3', 220, 300, 17, 66, { Value: 40, Orientation: 1 }),
    c('ProgressBar', 'ProgressBar4', 250, 300, 17, 66, { Value: 40, Orientation: 1, Scrolling: 1 }),
    c('ProgressBar', 'ProgressBar5', 8, 348, 200, 17, { Min: 0, Max: 200, Value: 50, Appearance: 0, BorderStyle: 1 }),
  ];
  return {
    id: 'gallery', name: 'Form1', code: '', controls,
    props: { ...Object.fromEntries(CONTROL_TYPES.Form.props.filter(p => p.designTime).map(p => [p.name, p.default])),
      Caption: 'Form1', Width: px(640 + 8), Height: px(372 + 26) },
  };
}

function column(title: string, surfaceEl: HTMLElement): HTMLElement {
  return h('div', { style: { display: 'inline-block', verticalAlign: 'top', margin: '0 16px 16px 0' } },
    h('div', { style: { margin: '0 0 4px', font: 'bold 11px var(--w98-font)' } }, title), surfaceEl);
}

const root = document.getElementById('gallery')!;
root.style.padding = '12px';
const design = renderFormSurface(galleryForm(), 'design', assets, { showGrid: true });
const run = renderFormSurface(galleryForm(), 'run', assets);
root.append(column('Design mode (grid on, non-interactive)', design.el), column('Run mode (interactive)', run.el));
// small hook for poking at it from the console
(window as unknown as Record<string, unknown>).gallery = { design, run };
