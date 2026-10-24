// File I/O built-ins: FreeFile EOF LOF Loc Seek Input InputB, the file system (Dir FileLen FileDateTime GetAttr CurDir,
// and the statements Kill MkDir RmDir ChDir ChDrive FileCopy SetAttr), and SaveSetting GetSetting DeleteSetting
// GetAllSettings. The open files and CurDir are the program's FileIO (BuiltinCtx.files).

import { VBRuntimeError } from '../errors';
import type { FileIO } from '../fileio/fileIO';
import { Empty, VBArray, toStr, type VBValue } from '../values';
import { def, intArg, optInt, type BuiltinCtx } from './util';
import { winPaths } from '../../platform';

function files(ctx: BuiltinCtx): FileIO {
  if (!ctx.files) throw new VBRuntimeError(68);
  return ctx.files;
}

const str = (v: VBValue | undefined) => (v === undefined ? '' : toStr(v));

// ---- open files ----

def('FreeFile', 0, 1, (a, ctx) => files(ctx).freeFile(optInt(a[0], 0)));
def('EOF', 1, 1, (a, ctx) => files(ctx).eof(intArg(a[0])));
def('LOF', 1, 1, (a, ctx) => files(ctx).lof(intArg(a[0])));
def('Loc', 1, 1, (a, ctx) => files(ctx).loc(intArg(a[0])));
def('Seek', 1, 1, (a, ctx) => files(ctx).seekPos(intArg(a[0])));
/** Input(n, #f): n characters (Input files) or bytes (Binary). InputB: the same, one character per byte. */
def(['Input', 'InputB'], 2, 2, (a, ctx) => files(ctx).inputChars(intArg(a[1]), intArg(a[0])));

// ---- the file system ----

def('Dir', 0, 2, (a, ctx) => files(ctx).dir(a[0] === undefined ? undefined : toStr(a[0]), optInt(a[1], 0)));
def('FileLen', 1, 1, (a, ctx) => files(ctx).fileLen(toStr(a[0])));
def('FileDateTime', 1, 1, (a, ctx) => files(ctx).fileDateTime(toStr(a[0])));
def('GetAttr', 1, 1, (a, ctx) => files(ctx).getAttr(toStr(a[0])));
def('CurDir', 0, 1, (a, ctx) => (a[0] === undefined ? files(ctx).curDir : files(ctx).curDirOf(toStr(a[0]))));
def('Kill', 1, 1, async (a, ctx) => { await files(ctx).kill(toStr(a[0])); return Empty; });
def('MkDir', 1, 1, async (a, ctx) => { await files(ctx).mkDir(toStr(a[0])); return Empty; });
def('RmDir', 1, 1, async (a, ctx) => { await files(ctx).rmDir(toStr(a[0])); return Empty; });
def('ChDir', 1, 1, async (a, ctx) => { await files(ctx).chDir(toStr(a[0])); return Empty; });
/** Windows: the drive of the first letter becomes current. A Mac or Linux has no drive letters: accepted and ignored. */
def('ChDrive', 1, 1, (a, ctx) => (winPaths() && ctx.files ? ctx.files.chDrive(toStr(a[0])).then(() => Empty) : Empty));
def('FileCopy', 2, 2, async (a, ctx) => { await files(ctx).fileCopy(toStr(a[0]), toStr(a[1])); return Empty; });
def('SetAttr', 2, 2, async (a, ctx) => { await files(ctx).setAttr(toStr(a[0]), intArg(a[1])); return Empty; });

// ---- settings (the app's settings file, keyed app name / section / key) ----

def('SaveSetting', 4, 4, async (a, ctx) => { await files(ctx).saveSetting(toStr(a[0]), toStr(a[1]), toStr(a[2]), toStr(a[3])); return Empty; });
def('GetSetting', 3, 4, async (a, ctx) => (await files(ctx).getSetting(toStr(a[0]), toStr(a[1]), toStr(a[2]))) ?? str(a[3]));
def('DeleteSetting', 2, 3, async (a, ctx) => {
  await files(ctx).deleteSetting(toStr(a[0]), toStr(a[1]), a[2] === undefined ? null : toStr(a[2]));
  return Empty;
});
/** A Variant array (0 To n-1, 0 To 1) of key and value; Empty when the section has none. */
def('GetAllSettings', 2, 2, async (a, ctx) => {
  const all = await files(ctx).allSettings(toStr(a[0]), toStr(a[1]));
  if (all.length === 0) return Empty;
  const arr = new VBArray('Variant', [[0, all.length - 1], [0, 1]]);
  all.forEach(([k, v], i) => { arr.set([i, 0], k); arr.set([i, 1], v); });
  return arr as VBValue;
});
