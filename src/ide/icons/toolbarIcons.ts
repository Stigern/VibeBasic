// 16x16 SVG icons for the IDE toolbar (original artwork, VB6-like).
const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">${body}</svg>`;
const page = '<path d="M3.5 1.5h6l3 3v10h-9z" fill="#fff" stroke="#000"/>';

export const TOOLBAR_ICONS: Record<string, string> = {
  new: svg(page + '<path d="M9.5 1.5v3h3" fill="none" stroke="#000"/>'),
  addForm: svg('<rect x="1.5" y="3.5" width="11" height="10" fill="#c0c0c0" stroke="#000"/><rect x="2" y="4" width="10" height="2" fill="#000080"/><rect x="3.5" y="7.5" width="5" height="3" fill="#fff" stroke="#000"/><path d="M12 1v5M9.5 3.5h5" stroke="#008000" stroke-width="2"/>'),
  addModule: svg('<path d="M2.5 1.5h7l2 2v11h-9z" fill="#fff" stroke="#000"/><path d="M4.5 6.5h5M4.5 8.5h5M4.5 10.5h3" stroke="#000080"/><path d="M12 8v6M9 11h6" stroke="#008000" stroke-width="2"/>'),
  menuEditor: svg('<rect x="0.5" y="1.5" width="15" height="4" fill="#c0c0c0" stroke="#000"/><path d="M2 3.5h3M7 3.5h3" stroke="#000"/><rect x="2.5" y="5.5" width="9" height="9" fill="#fff" stroke="#000"/><rect x="3" y="6" width="8" height="2" fill="#000080"/><path d="M4 10.5h6M4 12.5h5" stroke="#000"/>'),
  find: svg('<circle cx="6.5" cy="6.5" r="4" fill="#c0e0ff" stroke="#000"/><path d="M9.5 9.5l4.5 4.5" stroke="#000" stroke-width="2.5"/><path d="M4.5 5a2.5 2.5 0 011.5-1.3" fill="none" stroke="#fff"/>'),
  immediate: svg('<rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#000"/><rect x="2" y="3" width="12" height="2" fill="#000080"/><path d="M4 7l2 1.5L4 10M8 11h4" fill="none" stroke="#000"/>'),
  position: svg('<rect x="1.5" y="1.5" width="13" height="13" fill="#fff" stroke="#808080"/><path d="M1 4.5h4V1M11 1v3.5h4" fill="none" stroke="#000080"/><circle cx="8" cy="9" r="1.5" fill="#c00000"/>'),
  size: svg('<rect x="2.5" y="4.5" width="11" height="7" fill="#fff" stroke="#000"/><path d="M2.5 2h11M2.5 1v2M13.5 1v2M15 4.5v7M14 4.5h2M14 11.5h2" stroke="#000080" fill="none"/>'),
  open: svg('<path d="M1.5 4.5h5l1 1.5h6v7h-12z" fill="#ffff00" stroke="#000"/><path d="M1.5 13l2-5h12l-2 5z" fill="#c0c000" stroke="#000"/>'),
  save: svg('<rect x="1.5" y="1.5" width="13" height="13" fill="#000080" stroke="#000"/><rect x="4" y="2" width="8" height="5" fill="#fff"/><rect x="4" y="10" width="8" height="4" fill="#c0c0c0"/><rect x="9.5" y="11" width="1.5" height="2.5" fill="#000"/>'),
  cut: svg('<path d="M5 1l5 9M11 1L6 10" stroke="#000" fill="none"/><circle cx="5" cy="12.5" r="2" fill="none" stroke="#c00000"/><circle cx="11" cy="12.5" r="2" fill="none" stroke="#c00000"/>'),
  copy: svg('<path d="M1.5 1.5h5l2 2v7h-7z" fill="#fff" stroke="#000"/><path d="M5.5 5.5h5l2 2v7h-7z" fill="#fff" stroke="#000"/><path d="M10.5 5.5v2h2" fill="none" stroke="#000"/><path d="M7.5 10.5h3M7.5 12.5h3" stroke="#808080"/>'),
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
