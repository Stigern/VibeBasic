// File operations (New / Open / Save / Save As / Exit) and the "Save changes?" prompt.
import type { Backend } from '../backend/backend';
import { newProject } from '../model/controls';
import { parseProject, serializeProject } from '../model/serialize';
import { h } from '../ui98/dom';
import { messageBox98, showDialog98 } from '../ui98/dialogs';
import type { IdeState } from './ideState';

const VB_CRITICAL = 16;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class FileController {
  /** Called after a project was replaced; main.ts hooks this to open the startup form's designer. */
  onProjectReplaced: (() => void) | null = null;

  constructor(private ide: IdeState, private backend: Backend, private doc: Document = document) {}

  private fileName(): string {
    const p = this.ide.filePath;
    return (p ? p.split(/[\\/]/).pop() : '') || `${this.ide.project.name}.vbb`;
  }

  private error(message: string): Promise<number> {
    return messageBox98(this.doc, { prompt: message, title: 'VibeBasic', buttons: VB_CRITICAL });
  }

  /** Replaces the project; open windows close themselves on the 'project' event (their form/module is gone). */
  private replace(project: ReturnType<typeof newProject>, filePath: string | null): void {
    this.ide.setProject(project, filePath);
    this.updateTitle();
  }

  async newProject(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.replace(newProject(), null);
    this.onProjectReplaced?.();
  }

  async open(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const path = await this.backend.openProjectDialog();
    if (!path) return;
    let project;
    try {
      project = parseProject(await this.backend.readTextFile(path));
    } catch (e) {
      await this.error(errText(e));
      return;
    }
    this.replace(project, path);
    this.onProjectReplaced?.();
  }

  async save(): Promise<boolean> {
    return this.ide.filePath ? this.writeTo(this.ide.filePath) : this.saveAs();
  }

  async saveAs(): Promise<boolean> {
    const path = await this.backend.saveProjectDialog(`${this.ide.project.name}.vbb`);
    if (!path) return false;
    return this.writeTo(path);
  }

  private async writeTo(path: string): Promise<boolean> {
    try {
      await this.backend.writeTextFile(path, serializeProject(this.ide.project));
    } catch (e) {
      await this.error(errText(e));
      return false;
    }
    this.ide.filePath = path;
    this.ide.stack.markSaved();
    this.updateTitle();
    return true;
  }

  /** True = continue (clean, saved or discarded); false = the user cancelled. */
  async confirmDiscard(): Promise<boolean> {
    if (!this.ide.stack.isDirty) return true;
    const list = h('div', { class: 'dlg98-filelist' }, h('div', {}, this.fileName()));
    const v = await showDialog98(this.doc, {
      title: 'VibeBasic',
      content: h('div', {}, h('div', { class: 'dlg98-text' }, 'Save changes to the following files?'), list),
      buttons: [
        { label: 'Yes', value: 'yes', default: true },
        { label: 'No', value: 'no' },
        { label: 'Cancel', value: 'cancel', cancel: true },
      ],
    });
    if (v === 'yes') return this.save();
    return v === 'no';
  }

  async exit(): Promise<void> {
    if (await this.confirmDiscard()) await this.backend.closeMainWindow();
  }

  updateTitle(): void {
    void this.backend.setWindowTitle(`${this.ide.project.name} - VibeBasic [${this.ide.mode}]`);
  }
}
