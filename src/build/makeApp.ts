// File > Make <name>.app... (.exe on Windows): asks for a target and hands the project to the backend.
import type { Backend } from '../backend/backend';
import { platform, type Platform } from '../platform';
import { appNameOf, appTarget } from './appTarget';
import type { IdeState } from '../ide/ideState';
import { setProjectOptionsCmd } from '../model/commands';
import { serializeProject } from '../model/serialize';
import { DEFAULT_VERSION } from '../model/types';
import { messageBox98 } from '../ui98/dialogs';

const vbCritical = 16;

/** Mirrors the Rust sanitizer: drops control characters, `/` and `:`, trims whitespace and leading dots. On Windows also the
 *  other characters a file name cannot have (`\ * ? " < > |`) and trailing dots. */
export function sanitizeAppFileName(name: string, p: Platform = platform()): string {
  const bad = p === 'windows' ? /[\u0000-\u001f\u007f-\u009f/:\\*?"<>|]/ : /[\u0000-\u001f\u007f-\u009f/:]/;
  const cleaned = [...name].filter(c => !bad.test(c)).join('');
  let t = cleaned.trim().replace(/^\.+/, '').trim();
  if (p === 'windows') t = t.replace(/[. ]+$/, '');
  return t === '' ? 'Project1' : t;
}

/** The file name of a path the save dialog gave (Windows also separates folders with "\"). */
const fileOf = (path: string): string => (platform() === 'windows' ? path.split(/[\\/]/) : path.split('/')).pop() ?? path;

export async function makeAppFlow(ide: IdeState, backend: Backend, doc: Document = document): Promise<void> {
  if (ide.mode !== 'design') {
    await messageBox98(doc, { prompt: "Can't make the app while the program is running.", title: 'VibeBasic', buttons: 48 });
    return;
  }
  if (ide.busy) return;
  ide.setBusy(true);
  const body = doc.body;
  const oldCursor = body.style.cursor;
  body.style.cursor = 'wait';
  const p = ide.project;
  try {
    await backend.canMakeApp();
    const target = await backend.saveAppDialog(sanitizeAppFileName(p.title || p.name) + appTarget().ext);
    if (target === null) return;
    const appName = appNameOf(fileOf(target));
    // Auto Increment: as VB6, every Make adds 1 to the Revision (the project is changed, and the made app has the new number)
    const old = p.versionInfo ?? DEFAULT_VERSION;
    if (old.autoIncrement && old.revision < 9999) ide.stack.execute(setProjectOptionsCmd({ versionInfo: { ...old, revision: old.revision + 1 } }, 'Auto Increment'));
    const v = ide.project.versionInfo ?? DEFAULT_VERSION;
    const icon = p.iconAsset ? p.assets[p.iconAsset]?.dataBase64 ?? null : null;
    await backend.makeApp({
      targetPath: target, appName, projectJson: serializeProject(ide.project), iconPngBase64: icon, overwrite: true,
      version: { major: v.major, minor: v.minor, revision: v.revision, copyright: v.legalCopyright ?? '' },
      fileTypes: ide.project.fileTypes ?? [],
    });
  } catch (e) {
    await messageBox98(doc, { prompt: e instanceof Error ? e.message : String(e), title: 'VibeBasic', buttons: vbCritical });
  } finally {
    body.style.cursor = oldCursor;
    ide.setBusy(false);
  }
}
