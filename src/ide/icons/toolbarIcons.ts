// 16x16 SVG icons for the IDE toolbar (original artwork, VB6-like).
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${body}</svg>`;
const page = '<path d="M3.5 1.5h6l3 3v10h-9z" fill="#fff" stroke="#000"/>';

export const TOOLBAR_ICONS: Record<string, string> = {
  new: svg(page + '<path d="M9.5 1.5v3h3" fill="none" stroke="#000"/>'),
  open: svg('<path d="M1.5 4.5h5l1 1.5h6v7h-12z" fill="#ffff00" stroke="#000"/><path d="M1.5 13l2-5h12l-2 5z" fill="#c0c000" stroke="#000"/>'),
  save: svg('<rect x="1.5" y="1.5" width="13" height="13" fill="#000080" stroke="#000"/><rect x="4" y="2" width="8" height="5" fill="#fff"/><rect x="4" y="10" width="8" height="4" fill="#c0c0c0"/><rect x="9.5" y="11" width="1.5" height="2.5" fill="#000"/>'),
  cut: svg('<path d="M5 1l5 9M11 1L6 10" stroke="#000" fill="none"/><circle cx="5" cy="12.5" r="2" fill="none" stroke="#c00000"/><circle cx="11" cy="12.5" r="2" fill="none" stroke="#c00000"/>'),
  copy: svg('<path d="M2.5 1.5h6v9h-6z" fill="#fff" stroke="#000"/><path d="M7.5 5.5h6v9h-6z" fill="#fff" stroke="#000"/><path d="M9 8h3M9 10h3M9 12h3" stroke="#808080"/>'),
  paste: svg('<rect x="2.5" y="2.5" width="9" height="12" fill="#c0a060" stroke="#000"/><rect x="5" y="1" width="4" height="3" fill="#808080" stroke="#000"/><path d="M8.5 7.5h5v7h-5z" fill="#fff" stroke="#000"/>'),
  undo: svg('<path d="M5 3L2 6l3 3" fill="none" stroke="#000" stroke-width="1.5"/><path d="M2 6h7a4 4 0 010 8H6" fill="none" stroke="#000" stroke-width="1.5"/>'),
  redo: svg('<path d="M11 3l3 3-3 3" fill="none" stroke="#000" stroke-width="1.5"/><path d="M14 6H7a4 4 0 000 8h3" fill="none" stroke="#000" stroke-width="1.5"/>'),
  start: svg('<path d="M4 2l9 6-9 6z" fill="#008000" stroke="#000"/>'),
  break: svg('<rect x="3" y="2" width="3.5" height="12" fill="#000080" stroke="#000"/><rect x="9.5" y="2" width="3.5" height="12" fill="#000080" stroke="#000"/>'),
  end: svg('<rect x="3.5" y="3.5" width="9" height="9" fill="#000080" stroke="#000"/>'),
  projectExplorer: svg('<rect x="1.5" y="1.5" width="6" height="4" fill="#ffff00" stroke="#000"/><path d="M4.5 5.5v7h3M4.5 9.5h3" fill="none" stroke="#000"/><rect x="8.5" y="8" width="6" height="3.5" fill="#fff" stroke="#000"/><rect x="8.5" y="11.5" width="6" height="3" fill="#fff" stroke="#000"/>'),
  properties: svg('<rect x="1.5" y="1.5" width="13" height="13" fill="#fff" stroke="#000"/><path d="M1.5 4.5h13M6.5 4.5v10M3 7h2M3 9.5h2M3 12h2M8 7h5M8 9.5h4M8 12h5" stroke="#000" fill="none"/>'),
  toolbox: svg('<rect x="1.5" y="1.5" width="13" height="13" fill="#c0c0c0" stroke="#000"/><path d="M3 9l3-6 3 6zM9 9h4v4H9z" fill="#fff" stroke="#000"/><circle cx="4.5" cy="12" r="1.5" fill="#000080"/>'),
};
