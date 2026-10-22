// File > Make <name>.app...: asks for a target and hands the project to the backend.
import type { Backend } from '../backend/backend';
import type { IdeState } from '../ide/ideState';
import { serializeProject } from '../model/serialize';
import { messageBox98 } from '../ui98/dialogs';

const vbCritical = 16;

/** Mirrors the Rust sanitizer: drops control characters, `/` and `:`, trims whitespace and leading dots. */
export function sanitizeAppFileName(name: string): string {
  const cleaned = [...name].filter(c => !/[\u0000-\u001f\u007f-\u009f/:]/.test(c)).join('');
  const t = cleaned.trim().replace(/^\.+/, '').trim();
  return t === '' ? 'Project1' : t;
}

export async function makeAppFlow(ide: IdeState, backend: Backend, doc: Document = document): Promise<void> {
  if (ide.mode !== 'design') {
    await messageBox98(doc, { prompt: "Can't make the app while the program is running.", title: 'VibeBasic', buttons: 48 });
    return;
  }
  const p = ide.project;
  try {
    const target = await backend.saveAppDialog(sanitizeAppFileName(p.title || p.name) + '.app');
    if (target === null) return;
    const file = target.split('/').pop() ?? target;
    const appName = file.replace(/\.app$/i, '');
    const icon = p.iconAsset ? p.assets[p.iconAsset]?.dataBase64 ?? null : null;
    await backend.makeApp({ targetPath: target, appName, projectJson: serializeProject(p), iconPngBase64: icon, overwrite: true });
  } catch (e) {
    await messageBox98(doc, { prompt: e instanceof Error ? e.message : String(e), title: 'VibeBasic', buttons: vbCritical });
  }
}
