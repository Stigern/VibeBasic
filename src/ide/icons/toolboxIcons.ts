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
  CommonDialog: svg(box(1, 2, 14, 12, '#c0c0c0') + '<rect x="2" y="3" width="12" height="2" fill="#000080"/><path d="M3 7h6M3 9.5h6M3 12h4" stroke="#000"/><rect x="10" y="9" width="3" height="3" fill="#ffff00" stroke="#000"/>'),
  DriveListBox: svg(box(1, 3, 14, 5) + '<rect x="11" y="4" width="3" height="3" fill="#c0c0c0"/>' + box(2, 8, 12, 5, '#c0c0c0') + '<path d="M4 10.5h5" stroke="#000"/><rect x="11" y="10" width="2" height="1" fill="#0f0"/>'),
  DirListBox: svg(box(1, 1, 14, 14) + '<path d="M3 4h4v2H3zM5 7.5h4v2H5zM7 11h4v2H7z" fill="#ff0" stroke="#000"/>'),
  FileListBox: svg(box(1, 1, 14, 14) + '<path d="M3 3h5v6H3z" fill="#fff" stroke="#000"/><path d="M4 5h3M4 7h3M9 9h5v5H9z" stroke="#000" fill="#fff"/><path d="M10 11h3" stroke="#000"/>'),
  RichTextBox: svg(box(1, 2, 14, 12) + '<path d="M3 5h4M3 7.5h8M3 10h6M3 12.5h7" stroke="#000"/><path d="M9 4v3M8 7h3" stroke="#c00000" fill="none"/>'),
  Toolbar: svg(box(1, 3, 14, 10, '#c0c0c0') + box(2, 4, 4, 8, '#c0c0c0') + '<path d="M3.500 6.500l1 1 1-1M3.500 9.500h2" stroke="#000" fill="none"/>'
    + '<path d="M7.500 4v8" stroke="#808080"/>' + box(9, 4, 4, 8, '#c0c0c0') + '<rect x="10" y="6" width="2" height="2" fill="#008000"/><rect x="10" y="9" width="2" height="2" fill="#c00000"/>'),
  ImageList: svg(box(1, 2, 9, 8) + '<path d="M2 9l3-4 2 2 1-1 2 3z" fill="#0000c0"/>' + box(6, 7, 9, 8) + '<path d="M7 14l3-4 2 2 1-1 2 3z" fill="#008000"/><circle cx="12.500" cy="9.500" r="1" fill="#c00000"/>'),
  SSTab: svg('<path d="M1.5 14.5v-9h13v9z" fill="#c0c0c0" stroke="#000"/><path d="M1.5 5.5v-3h4v3" fill="#fff" stroke="#000"/>'
    + '<path d="M5.5 5.5v-2h4v2M9.5 5.5v-2h5v2" fill="#c0c0c0" stroke="#000"/><path d="M3 8h6M3 10h8M3 12h5" stroke="#808080"/>'),
  DTPicker: svg(box(1, 3, 14, 10) + box(11, 4, 3, 8, '#c0c0c0') + '<path d="M11.500 7h3l-1.500 2z" fill="#000"/><path d="M3 6h2M3 8h5M3 10h3" stroke="#000"/><rect x="3" y="5" width="2" height="2" fill="#000080"/>'),
  MonthView: svg(box(1, 1, 14, 14) + '<rect x="2" y="2" width="12" height="3" fill="#000080"/><path d="M3 7h2M6 7h2M9 7h2M3 9h2M6 9h2M9 9h2M3 11h2M6 11h2M9 11h2M12 7h1M12 9h1" stroke="#808080"/>'
    + '<circle cx="7" cy="10" r="1.800" fill="none" stroke="#c00000"/>'),
  MaskedEdit: svg(box(1, 4, 14, 8) + '<path d="M3 9.500h2M6 9.500h2" stroke="#000"/><path d="M10 9.500h3" stroke="#808080"/><path d="M9.500 5.500h0M9 6v2M11 6v2M8.500 6.800h3M8.500 7.800h3" stroke="#000080" fill="none"/>'),
  WebBrowser: svg(box(1, 1, 14, 14) + '<rect x="2" y="2" width="12" height="2" fill="#000080"/><circle cx="8" cy="9.500" r="4" fill="#00a0e0" stroke="#000080"/>'
    + '<path d="M4 9.500h8M8 5.500v8M6 6.500c-1 2-1 4 0 6M10 6.500c1 2 1 4 0 6" stroke="#000080" fill="none"/>'),
  Inet: svg('<circle cx="7" cy="7" r="5.500" fill="#00a0e0" stroke="#000080"/><path d="M1.500 7h11M7 1.500v11M4.500 2.500c-1.500 3-1.500 6 0 9M9.500 2.500c1.500 3 1.500 6 0 9" stroke="#000080" fill="none"/>'
    + '<path d="M12 9v4M10 11.500l2 2.500 2-2.500" stroke="#008000" fill="none" stroke-width="1.500"/>'),
  Winsock: svg(box(0, 2, 6, 5, '#c0c0c0') + '<rect x="1" y="3" width="4" height="3" fill="#008080"/>' + box(10, 9, 6, 5, '#c0c0c0') + '<rect x="11" y="10" width="4" height="3" fill="#008080"/>'
    + '<path d="M3 7v4h7M6 4.500h4v4.500" stroke="#000" fill="none"/><path d="M1 8h4M11 15h4" stroke="#000"/>'),
  MSComm: svg('<path d="M1.500 6.500c0-2.500 2.500-4 6.500-4s6.500 1.500 6.500 4v1h-3v-1.500h-7v1.500h-3z" fill="#000" stroke="#000"/>'
    + '<path d="M4.500 7.500h7l2 6h-11z" fill="#c0c0c0" stroke="#000"/><path d="M6 9h1M8 9h1M10 9h1M6 11h1M8 11h1M10 11h1" stroke="#000"/>'),
  SysInfo: svg(box(1, 1, 14, 10, '#c0c0c0') + '<rect x="2" y="2" width="12" height="8" fill="#008080"/><path d="M8 3v1M8 5v4" stroke="#fff"/>'
    + '<path d="M5.500 13.500h5" stroke="#000"/><rect x="6" y="11" width="4" height="2" fill="#808080"/>'),
  MSChart: svg(box(1, 1, 14, 14) + '<rect x="2" y="2" width="12" height="12" fill="#c0c0c0"/><rect x="3" y="8" width="2" height="5" fill="#000080" stroke="#000"/><rect x="6" y="4" width="2" height="9" fill="#800000" stroke="#000"/>'
    + '<rect x="9" y="6" width="2" height="7" fill="#ffff00" stroke="#000"/><rect x="12" y="9" width="1" height="4" fill="#008080" stroke="#000"/>'),
  MMControl: svg(box(0, 4, 6, 8, '#c0c0c0') + box(5, 4, 6, 8, '#c0c0c0') + box(10, 4, 6, 8, '#c0c0c0')
    + '<path d="M2 6v4l2.500-2z" fill="#000"/><rect x="7" y="6" width="2" height="4" fill="#000"/><path d="M12 6h1v4h-1zM14 6l-1 2 1 2z" fill="#000"/>'),
  MediaPlayer: svg(box(1, 1, 14, 10, '#000') + '<path d="M6 3.500v5l4-2.500z" fill="#00ff00"/>' + box(1, 11, 14, 4, '#c0c0c0') + '<rect x="3" y="12.500" width="6" height="1" fill="#808080"/><rect x="5" y="12" width="2" height="2" fill="#000"/>'),
  // a record bar with its arrows; the ADO one has a database cylinder above it
  Data: svg(box(0, 5, 16, 7, '#c0c0c0') + '<rect x="5" y="6" width="6" height="5" fill="#fff"/><path d="M1 8.5l3-2.500v5zM15 8.5l-3-2.500v5z" fill="#000"/>'),
  Adodc: svg('<path d="M4.500 1.500v3.500c0 .8 1.600 1.400 3.500 1.400s3.500-.6 3.500-1.400V1.500" fill="#ffff80" stroke="#000"/><ellipse cx="8" cy="1.500" rx="3.500" ry="1" fill="#ffffc0" stroke="#000"/>'
    + box(0, 8, 16, 7, '#c0c0c0') + '<rect x="5" y="9" width="6" height="5" fill="#fff"/><path d="M1 11.500l3-2.500v5zM15 11.500l-3-2.500v5z" fill="#000"/>'),
  DataGrid: svg(box(1, 2, 14, 12) + '<rect x="2" y="3" width="12" height="2" fill="#c0c0c0"/><rect x="2" y="5" width="2" height="8" fill="#c0c0c0"/>'
    + '<path d="M2 5.500h12M2 8.500h12M2 11.500h12M4.500 3v10M9.500 3v10" stroke="#808080"/><path d="M2.500 6.500l1 1-1 1z" fill="#000"/>'),
  DataList: svg(box(1, 1, 12, 14) + '<path d="M3 4h7M3 7h7M3 10h7" stroke="#000"/><rect x="3" y="6" width="7" height="2" fill="#000080" opacity=".7"/>'
    + '<path d="M11.500 9v4c0 .6 1 1 2 1s2-.4 2-1V9" fill="#ffff80" stroke="#000"/><ellipse cx="13.500" cy="9" rx="2" ry=".8" fill="#ffffc0" stroke="#000"/>'),
  DataCombo: svg(box(0, 2, 13, 8) + '<rect x="9" y="3" width="3" height="6" fill="#c0c0c0"/><path d="M9.500 5.500h2L10.500 7.500z" fill="#000"/>'
    + '<path d="M2 6h5" stroke="#000"/><path d="M11.500 10v4c0 .6 1 1 2 1s2-.4 2-1v-4" fill="#ffff80" stroke="#000"/><ellipse cx="13.500" cy="10" rx="2" ry=".8" fill="#ffffc0" stroke="#000"/>'),
  SSPanel: svg('<rect x="1" y="3" width="14" height="10" fill="#c0c0c0"/><path d="M1.500 12.500V3.500h13" stroke="#fff" fill="none"/><path d="M14.500 3.500v9h-13" stroke="#808080" fill="none"/>'
    + '<rect x="3" y="6" width="5" height="4" fill="#000080"/><path d="M9 8h4" stroke="#000"/>'),
  SSCommand: svg('<rect x="1" y="3" width="14" height="10" fill="#c0c0c0" stroke="#000"/><path d="M2 12V4h11" stroke="#fff" fill="none"/><path d="M13.500 4v8h-11" stroke="#808080" fill="none"/>'
    + '<rect x="4" y="6" width="3" height="4" fill="#008080"/><path d="M8 8h4" stroke="#000"/>'),
  SSCheck: svg('<rect x="2" y="2" width="11" height="11" fill="#c0c0c0"/><path d="M2.500 12.500v-10h10" stroke="#fff" fill="none"/><path d="M12.500 2.500v10h-10" stroke="#808080" fill="none"/>'
    + '<rect x="4" y="4" width="7" height="7" fill="#fff" stroke="#000"/><path d="M5 7.500l2 2 3-4" stroke="#008000" fill="none" stroke-width="1.500"/>'),
  SSOption: svg('<circle cx="8" cy="8" r="6.500" fill="#c0c0c0" stroke="#808080"/><path d="M3.500 4.500A6 6 0 0 1 11.500 2.500" stroke="#fff" fill="none"/>'
    + '<circle cx="8" cy="8" r="3.500" fill="#fff" stroke="#000"/><circle cx="8" cy="8" r="1.500" fill="#008000"/>'),
  SSFrame: svg('<rect x="1.500" y="4.500" width="13" height="9" fill="none" stroke="#808080"/><path d="M2.500 13.500V5.500h12" stroke="#fff" fill="none"/>'
    + '<rect x="3" y="2" width="6" height="5" fill="#c0c0c0"/><path d="M4 4.500h4" stroke="#000"/>'),
  SSRibbon: svg('<rect x="2" y="2" width="12" height="12" fill="#c0c0c0"/><path d="M2.500 13.500v-11h11" stroke="#fff" fill="none"/><path d="M13.500 2.500v11h-11" stroke="#808080" fill="none"/>'
    + '<path d="M5 11V5l3 3 3-3v6" stroke="#0000c0" fill="none" stroke-width="1.500"/>'),
  Agent: svg('<rect x="1.500" y="0.500" width="9" height="6" rx="2" fill="#ffffe1" stroke="#000"/><path d="M4 6.500l-1 2.500 3-2.500" fill="#ffffe1" stroke="#000"/>'
    + box(6, 8, 9, 7, '#c0c0c0') + '<rect x="7" y="9" width="7" height="4" fill="#000080"/><rect x="8" y="10" width="1" height="1" fill="#00ffff"/><rect x="12" y="10" width="1" height="1" fill="#00ffff"/>'
    + '<rect x="10" y="6" width="1" height="2" fill="#ff0000"/>'),
  Form: svg(box(1, 2, 14, 12, '#c0c0c0') + '<rect x="2" y="3" width="12" height="3" fill="#000080"/>'),
};
