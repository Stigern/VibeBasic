// Double clicks in every webview. Chromium (WebView2 on Windows) fires no dblclick when the first click's handler replaced the
// element under the pointer, and a DirListBox, TreeView or ListView repaints its rows on a click; WebKit fires it anyway. A second
// click (detail 2) that no dblclick follows gets one, dispatched at the pointer once the click's own events are over.

const installed = new WeakSet<Document>();

export function ensureDblClick(doc: Document): void {
  const win = doc.defaultView;
  if (!win || installed.has(doc)) return;
  installed.add(doc);
  let pending: MouseEvent | null = null;
  doc.addEventListener('click', e => {
    if (e.detail !== 2) return;
    pending = e;
    win.setTimeout(() => {   // a real dblclick comes right after the click, in the same task
      if (pending !== e) return;
      pending = null;
      const at = (typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(e.clientX, e.clientY) : null)
        ?? (e.target instanceof Node && e.target.isConnected ? e.target : null);
      at?.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, composed: true, detail: 2,
        clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY, button: e.button, buttons: e.buttons,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      }));
    }, 0);
  }, true);
  doc.addEventListener('dblclick', () => { pending = null; }, true);
}
