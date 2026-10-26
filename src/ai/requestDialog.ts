import type { Backend } from '../backend/backend';
import type { FormDef } from '../model/types';
import { check } from '../ide/projectDialogs';
import { h } from '../ui98/dom';
import { showDialog98 } from '../ui98/dialogs';
import { isMac } from '../platform';
import { loadReferenceImage, MAX_REFERENCES, type ReferenceImage } from './referenceImages';
import './requestDialog.css';

export type RequestScope = 'selection' | 'procedure' | 'file' | 'form';
export interface AskRequest {
  prompt: string; scope: RequestScope; formPicture: string | null; references: ReferenceImage[];
  minimal: boolean; preserveLayout: boolean; explain: boolean;
}
interface RequestDialogOptions {
  itemName: string; form: FormDef | null; codeMode: boolean; selection?: string; procName?: string;
  model?: string; vision?: boolean; detected?: Promise<{ vision?: boolean }>; formPictureDefault: boolean;
  backend: Pick<Backend, 'openFileDialog' | 'readBinaryFile'>;
  renderFormPicture(): Promise<string | null>;
}
export const requestDialogImages = { load: loadReferenceImage };

export async function showRequestDialog(doc: Document, o: RequestDialogOptions): Promise<AskRequest | null> {
  const box = h('textarea', { class: 'ai-prompt', rows: 7, 'aria-label': 'What should the AI do?', 'data-autofocus': '' });
  const requestStatus = h('div', { class: 'ai-request-status', role: 'status', 'aria-live': 'polite' });
  box.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const a = box.selectionStart, b = box.selectionEnd;
    box.value = `${box.value.slice(0, a)}\n${box.value.slice(b)}`;
    box.selectionStart = box.selectionEnd = a + 1;
  });
  const scope = h('select', { class: 'ai-scope', 'aria-label': 'Work on' });
  const addScope = (value: RequestScope, label: string) => scope.append(h('option', { value }, label));
  if (o.codeMode) {
    if (o.selection?.trim()) addScope('selection', 'Selected code');
    if (o.procName) addScope('procedure', `Current procedure: ${o.procName}`);
    addScope('file', `Whole code file: ${o.itemName}`);
  } else addScope('form', `Current form: ${o.itemName}`);
  const include = check('Include form picture (schematic)', !o.codeMode && o.formPictureDefault && !!o.form && o.vision !== false);
  const minimal = check('Make the smallest necessary change', false);
  const preserve = check('Preserve the existing layout', false);
  preserve.input.disabled = !o.form;
  if (!o.form) preserve.el.title = 'Layout instructions apply when the code belongs to a form.';
  const explain = check('Explain the changes', false);
  const thumbnail = h('div', { class: 'ai-form-attachment' });
  const referencesEl = h('div', { class: 'ai-reference-list' });
  const status = h('div', { class: 'ai-attachment-status', role: 'status', 'aria-live': 'polite' });
  const visionStatus = h('div', { class: 'ai-vision-status', role: 'status', 'aria-live': 'polite' });
  const summary = h('div', { class: 'ai-context-summary', 'aria-live': 'polite' });
  const detailLines = h('div', { class: 'ai-context-detail-lines' });
  const detailToggle = h('summary', { tabindex: '0' }, 'Show details');
  const details = h('details', { class: 'ai-context-details' }, detailToggle, detailLines);
  // The modal's Enter handler would otherwise submit instead of opening native details.
  detailToggle.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); details.open = !details.open; }
  });
  details.addEventListener('toggle', () => { detailToggle.textContent = details.open ? 'Hide details' : 'Show details'; });
  const add = h('button', { type: 'button' }, 'Add reference image...');
  let references: ReferenceImage[] = [], picture: string | null = null;
  let vision = o.vision, busy = 0, active = true, rendering = false;
  const content = h('div', { class: 'ai-request' },
    h('label', {}, 'What should the AI do?', box),
    h('div', { class: 'ai-shortcut-hint' }, `${isMac() ? 'Cmd' : 'Ctrl'}+Enter to ask · Enter for a new line`), requestStatus,
    h('label', { class: 'ai-scope-row' }, 'Work on:', scope),
    h('fieldset', {}, h('legend', {}, 'Images'), include.el,
      ...(!o.form ? [h('div', { class: 'ai-context-note' }, 'No form belongs to this code file. You can still attach reference images.')] : []),
      h('div', { class: 'ai-attachments' }, thumbnail, referencesEl), add,
      h('div', { class: 'ai-context-note' }, 'Reference images: PNG, JPEG or WebP · up to 2 files · 5 MiB each. Click an image to enlarge.'), status),
    h('fieldset', {}, h('legend', {}, 'Instructions'), minimal.el, preserve.el, explain.el),
    h('fieldset', {}, h('legend', {}, 'Context to send'), summary, details),
    h('div', { class: 'ai-request-model' }, h('span', { class: 'ai-model-status' }, `Model: ${o.model || 'configured AI server'}`), visionStatus));
  const showImage = (url: string, title: string) => showDialog98(doc, {
    title, content: h('div', { class: 'ai-image-preview' }, h('img', { src: url, alt: title })),
    buttons: [{ label: 'Close', value: 'close', default: true, cancel: true }],
  });
  const imageButton = (url: string, title: string, imageClass = '') => h('button', {
    type: 'button', class: 'ai-image-open', 'aria-label': `View ${title}`, title: 'Open larger preview', onclick: async () => {
      await showImage(url, title);
      if (!active) return;
      // Loading/detection can rebuild the cards while the viewer is open; the original focused button may be detached.
      const current = [...content.querySelectorAll<HTMLButtonElement>('.ai-image-open')].find(b => b.getAttribute('aria-label') === `View ${title}`);
      (current ?? box).focus();
    },
  }, h('img', { class: imageClass, src: url, alt: title }));
  function update(): void {
    if (!active) return;
    include.input.disabled = !o.form || vision === false;
    add.disabled = busy > 0 || vision === false || references.length >= MAX_REFERENCES;
    const submit = [...(content.closest('.dlg98')?.querySelectorAll('button') ?? [])].find(b => b.textContent === 'Ask AI');
    if (submit) submit.disabled = busy > 0 || (vision === false && references.length > 0);
    visionStatus.textContent = vision === false ? `This model does not support images.${references.length ? ' Remove reference images to continue without them.' : ''}`
      : vision === true ? 'Images supported' : 'Image support not confirmed yet';
    if (rendering) status.textContent = 'Preparing form picture...';
    else if (busy > 0) status.textContent = 'Loading reference image...';
    status.classList.toggle('ai-status-error', busy === 0 && !!status.textContent);
    thumbnail.replaceChildren(...(include.input.checked && picture ? [h('div', { class: 'ai-image-card' },
      h('div', { class: 'ai-image-title' }, 'Current form'), imageButton(picture, `current form picture: ${o.itemName} (schematic)`, 'ai-form-thumbnail'),
      h('div', { class: 'ai-image-footer' }, h('div', { class: 'ai-image-name', title: o.itemName }, `${o.itemName} · schematic`)))] : []));
    referencesEl.replaceChildren(...references.map((ref, i) => h('div', { class: 'ai-image-card ai-reference' },
      h('div', { class: 'ai-image-title' }, `Reference ${i + 1}`), imageButton(ref.url, `reference ${i + 1}: ${ref.name}`),
      h('div', { class: 'ai-image-footer' }, h('div', { class: 'ai-image-name', title: ref.name }, ref.name),
        h('button', { type: 'button', 'aria-label': `Remove ${ref.name}`, onclick: () => { references = references.filter((_, index) => index !== i); update(); } }, 'Remove')))));
    const lines = [scope.selectedOptions[0]?.textContent ?? '',
      o.form ? `Control names and properties: ${o.form.name} (${o.form.controls.length} controls)` : 'Project form descriptions',
      'Relevant code, declarations and available project symbols',
      include.input.checked && picture ? 'Current form picture: attached (schematic)' : 'Current form picture: not attached',
      `${references.length} reference ${references.length === 1 ? 'image' : 'images'}`];
    const scopeLabel = scope.value === 'selection' ? 'Selected code' : scope.value === 'procedure' ? 'Current procedure' : scope.value === 'file' ? 'Whole code file' : 'Current form';
    const imageCount = references.length + (include.input.checked && picture ? 1 : 0);
    summary.textContent = [scopeLabel, ...(o.form ? [`${o.form.controls.length} controls`] : []), `${imageCount} ${imageCount === 1 ? 'image' : 'images'}`].join(' · ');
    detailLines.replaceChildren(...lines.map(t => h('div', {}, t)));
  }
  async function renderPicture(): Promise<void> {
    if (!o.form || !include.input.checked || picture || rendering || vision === false) { update(); return; }
    rendering = true; busy++; update();
    try {
      const rendered = await o.renderFormPicture();
      if (!active) return;
      if (!rendered) throw new Error('Could not render the form picture. You can continue without it.');
      picture = rendered;
      status.textContent = '';
    } catch (e) {
      if (active) { include.input.checked = false; status.textContent = e instanceof Error ? e.message : 'Could not render the form picture.'; }
    } finally { rendering = false; busy--; update(); }
  }
  include.input.addEventListener('change', () => { void renderPicture(); });
  scope.addEventListener('change', update);
  add.addEventListener('click', () => { void (async () => {
    busy++; status.textContent = 'Loading reference image...'; update();
    try {
      const ref = await requestDialogImages.load(o.backend, doc);
      if (!active) return;
      if (ref) references.push(ref);
      status.textContent = '';
    } catch (e) { if (active) status.textContent = e instanceof Error ? e.message : 'Could not load the reference image.'; }
    finally { busy--; update(); }
  })(); });
  const openDialog = () => showDialog98(doc, { title: `Ask AI - ${o.itemName} (${o.codeMode ? 'Code' : 'Form'})`, content,
    buttons: [{ label: 'Ask AI', value: 'ok', default: true }, { label: 'Cancel', value: 'cancel', cancel: true }] });
  const dialog = openDialog();
  update(); void renderPicture();
  o.detected?.then(found => {
    if (!active || found.vision === undefined) return;
    vision = found.vision;
    if (!vision && include.input.checked) { include.input.checked = false; status.textContent = 'The form picture was removed because this model does not support images.'; }
    update();
  }, () => {});
  let result = await dialog;
  while (result === 'ok' && !box.value.trim()) {
    requestStatus.textContent = 'Describe what the AI should do before sending.';
    const next = openDialog();
    update();
    result = await next;
  }
  active = false;
  if (result !== 'ok' || !box.value.trim()) return null;
  return { prompt: box.value.trim(), scope: scope.value as RequestScope, formPicture: include.input.checked ? picture : null,
    references, minimal: minimal.input.checked, preserveLayout: preserve.input.checked, explain: explain.input.checked };
}

/** Instructions are explicit context, separate from the user's request for reliable question detection. */
export function requestInstructions(request: AskRequest, procName?: string): string[] {
  return [
    request.scope === 'selection' ? 'Work only on the selected code.' : request.scope === 'procedure' ? `Work on the current procedure${procName ? ` ${procName}` : ''}; preserve other procedures unless a necessary dependency must change.`
      : request.scope === 'file' ? 'The work scope is the whole current code file. Return complete changed procedures and module-level declarations; do not return bare code for insertion into the current procedure.' : '',
    request.minimal ? 'Make the smallest necessary change; preserve unrelated code and behavior.' : '',
    request.preserveLayout ? 'Preserve the existing layout, control positions and sizes unless the request explicitly requires changing them.' : '',
    request.scope === 'form' ? 'Set fixed appearance (fonts, colors and captions) in design-time ops, not only in Form_Load, so the designer matches the running program.' : '',
    request.explain ? 'Explain the changes in at most three sentences. In form mode put this in an optional "explanation" string field next to "ops" and "code". In code mode put it outside the code block; this request permits up to three sentences instead of the usual one.' : '',
  ].filter(Boolean);
}
