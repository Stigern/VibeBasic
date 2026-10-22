// Toolbox icons: original 16x16 pixel-style SVGs in the spirit of VB6's toolbox (not copies of any Microsoft bitmaps).
import type { ControlType } from '../../model/types';

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${body}</svg>`;
const box = (x: number, y: number, w: number, h: number, fill = '#fff') =>
  `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" fill="${fill}" stroke="#000"/>`;

export const TOOLBOX_ICONS: Record<ControlType | 'Pointer', string> = {
  Pointer: svg('<path d="M4 2v11l3-3 2 4 2-1-2-4h4z" fill="#fff" stroke="#000"/>'),
  PictureBox: svg(box(1, 2, 14, 12) + '<path d="M2 12l4-5 3 3 2-2 3 4z" fill="#008000"/><circle cx="11" cy="5.5" r="1.5" fill="#ff0"/>'),
  Label: svg('<text x="8" y="13" font-family="serif" font-size="13" font-weight="bold" text-anchor="middle" fill="#000">A</text>'),
  TextBox: svg(box(1, 3, 14, 10) + '<text x="3" y="11" font-family="sans-serif" font-size="8" fill="#000">ab</text><path d="M11 5v6" stroke="#000"/>'),
  Frame: svg('<rect x="1.5" y="4.5" width="13" height="9" fill="none" stroke="#808080"/><rect x="3" y="2" width="6" height="5" fill="#c0c0c0"/><path d="M4 4.5h4" stroke="#000"/>'),
  CommandButton: svg('<rect x="1" y="3" width="14" height="10" fill="#c0c0c0" stroke="#000"/><path d="M2 12V4h11" stroke="#fff" fill="none"/><path d="M5 8h6" stroke="#000"/>'),
  CheckBox: svg(box(3, 3, 10, 10) + '<path d="M5 8l2 2 4-4" stroke="#000" fill="none" stroke-width="1.5"/>'),
  OptionButton: svg('<circle cx="8" cy="8" r="5.5" fill="#fff" stroke="#000"/><circle cx="8" cy="8" r="2.2" fill="#000"/>'),
  ComboBox: svg(box(1, 3, 14, 10) + '<rect x="11" y="4" width="3" height="8" fill="#c0c0c0"/><path d="M11.5 7.5h2L12.5 9.5z" fill="#000"/>'),
  ListBox: svg(box(2, 2, 12, 12) + '<path d="M4 5h8M4 8h8M4 11h8" stroke="#000"/><rect x="4" y="7" width="8" height="2" fill="#000080" opacity=".7"/>'),
  HScrollBar: svg(box(1, 5, 14, 6, '#c0c0c0') + '<rect x="5" y="6" width="4" height="4" fill="#c0c0c0" stroke="#000"/><path d="M3 8l2-1.5v3zM13 8l-2-1.5v3z" fill="#000"/>'),
  VScrollBar: svg(box(5, 1, 6, 14, '#c0c0c0') + '<rect x="6" y="5" width="4" height="4" fill="#c0c0c0" stroke="#000"/><path d="M8 3l-1.5 2h3zM8 13l-1.5-2h3z" fill="#000"/>'),
  Timer: svg('<circle cx="8" cy="8.5" r="6" fill="#fff" stroke="#000"/><path d="M8 8.5V4.5M8 8.5l3 1.5" stroke="#000" fill="none"/><rect x="6" y="1" width="4" height="1.5" fill="#000"/>'),
  Image: svg(box(1, 2, 14, 12) + '<path d="M2 13l4-6 3 4 2-2 3 4z" fill="#0000c0"/><circle cx="11.5" cy="5.5" r="1.3" fill="#c00000"/>'),
  ProgressBar: svg(box(1, 5, 14, 6) + '<rect x="2" y="6" width="3" height="4" fill="#000080"/><rect x="6" y="6" width="3" height="4" fill="#000080"/>'),
  Shape: svg('<rect x="1.5" y="8.5" width="8" height="6" fill="#fff" stroke="#000"/><circle cx="10" cy="6" r="4.5" fill="#c0c0c0" stroke="#000"/>'),
  Line: svg('<path d="M2 14L14 2" stroke="#000" stroke-width="1.5" fill="none" shape-rendering="auto"/>'),
  Slider: svg('<rect x="1.5" y="7" width="13" height="3" fill="#808080" stroke="#000"/><path d="M6 3.5h4v6l-2 2.5-2-2.5z" fill="#c0c0c0" stroke="#000"/><path d="M2 13v2M5 13v2M8 13v2M11 13v2M14 13v2" stroke="#000"/>'),
  UpDown: svg(box(4, 1, 8, 7, '#c0c0c0') + box(4, 8, 8, 7, '#c0c0c0') + '<path d="M6 6l2-3 2 3zM6 10l2 3 2-3z" fill="#000"/>'),
  StatusBar: svg(box(1, 5, 14, 6, '#c0c0c0') + '<path d="M2.5 6.5h6v3h-6zM9.5 6.5h4v3h-4z" fill="#fff" stroke="#808080"/>'),
  TabStrip: svg('<path d="M1.5 14.5v-9h13v9z" fill="#c0c0c0" stroke="#000"/><path d="M1.5 5.5v-2.5h5v2.5M7.5 5.5v-1.5h4v1.5" fill="#fff" stroke="#000"/>'),
  TreeView: svg('<path d="M3 3v10M3 6h3M3 12h3M7 9h3" stroke="#808080" fill="none"/>' + box(1, 2, 4, 3, '#fff') + box(6, 5, 8, 3, '#fff') + box(6, 11, 8, 3, '#000080') + box(8, 8, 6, 3, '#fff')),
  ListView: svg(box(1, 2, 14, 12) + '<path d="M1 5.5h14M6 2v12" stroke="#808080"/><path d="M3 8h2M3 10.5h2M3 13h2M8 8h5M8 10.5h5" stroke="#000"/>'),
  MSFlexGrid: svg(box(1, 2, 14, 12) + '<path d="M1 5.5h14M1 8.5h14M1 11.5h14M5.5 2v12M10.5 2v12" stroke="#808080"/><rect x="2" y="3" width="3" height="2" fill="#c0c0c0"/>'),
  Form: svg(box(1, 2, 14, 12, '#c0c0c0') + '<rect x="2" y="3" width="12" height="3" fill="#000080"/>'),
};
