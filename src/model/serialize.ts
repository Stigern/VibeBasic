import type { Project } from './types';

export const PROJECT_FORMAT = 'vibebasic-project';
export const PROJECT_VERSION = 1;

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFormatError';
  }
}

const NOT_A_PROJECT = 'This is not a VibeBasic project file.';
const TOO_NEW = 'This project was made with a newer version of VibeBasic.';

/** JSON with two-space indent; `format` and `version` come first, then the Project fields. */
export function serializeProject(p: Project): string {
  return JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, ...p }, null, 2) + '\n';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isControl(c: unknown): boolean {
  return isObject(c) && typeof c.id === 'string' && typeof c.type === 'string' && typeof c.name === 'string'
    && (c.index === null || typeof c.index === 'number')
    && (c.parentId === null || typeof c.parentId === 'string') && isObject(c.props);
}

function isForm(f: unknown): boolean {
  return isObject(f) && typeof f.id === 'string' && typeof f.name === 'string' && isObject(f.props)
    && Array.isArray(f.controls) && f.controls.every(isControl) && typeof f.code === 'string';
}

function isModule(m: unknown): boolean {
  return isObject(m) && typeof m.id === 'string' && typeof m.name === 'string' && typeof m.code === 'string';
}

function isAsset(a: unknown): boolean {
  return isObject(a) && typeof a.mime === 'string' && typeof a.dataBase64 === 'string';
}

function isProjectShape(o: Record<string, unknown>): boolean {
  return typeof o.name === 'string' && typeof o.title === 'string' && typeof o.startupForm === 'string'
    && Array.isArray(o.forms) && o.forms.every(isForm)
    && Array.isArray(o.modules) && o.modules.every(isModule)
    && isObject(o.assets) && Object.values(o.assets).every(isAsset)
    && (o.iconAsset === null || typeof o.iconAsset === 'string');
}

export function parseProject(text: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFormatError(NOT_A_PROJECT);
  }
  if (!isObject(raw) || raw.format !== PROJECT_FORMAT || typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new ProjectFormatError(NOT_A_PROJECT);
  }
  if (raw.version > PROJECT_VERSION) throw new ProjectFormatError(TOO_NEW);
  if (!isProjectShape(raw)) throw new ProjectFormatError(NOT_A_PROJECT);
  const { format: _format, version: _version, ...rest } = raw;
  return rest as unknown as Project;
}
