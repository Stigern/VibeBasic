// Review 08 (M2, M3): Input files are read in chunks with a size cap, an Open that resolves after the end of the program is
// closed, and a new program first closes what an earlier run left open (fioReset), after that run's closeAll.
import { describe, expect, test } from 'vitest';
import { FileIO, MAX_READ_BYTES, READ_CHUNK } from '../../src/lang/fileio/fileIO';
import type { TypeSource } from '../../src/lang/fileio/binary';
import type { FileAccess, FileMode } from '../../src/lang/fileio/fsApi';
import { MemoryFs } from '../../src/lang/fileio/memoryFs';

const types = {} as TypeSource;
const err = (n: number) => expect.objectContaining({ number: n });

class LoggingFs extends MemoryFs {
  log: string[] = [];
  reads: number[] = [];
  override async fioRead(id: number, pos: number, len: number): Promise<Uint8Array> {
    this.reads.push(len);
    return super.fioRead(id, pos, Math.min(len, 64 * 1024 * 1024));
  }
  override async fioClose(id: number): Promise<void> { this.log.push(`close ${id}`); return super.fioClose(id); }
  override async fioReset(): Promise<void> { this.log.push('reset'); return super.fioReset(); }
}

describe('FileIO robustness', () => {
  test('an Input file bigger than one chunk is read in chunks, none over READ_CHUNK', async () => {
    const fs = new LoggingFs();
    const n = READ_CHUNK * 2 + 5;
    const data = new Uint8Array(n).fill(0x41);
    data.set([0x0d, 0x0a], 3);
    fs.writeFile('/app/big.txt', data);
    const io = new FileIO(() => fs, '/app', types);
    await io.open('big.txt', 'input', '', 1);
    expect(fs.reads).toEqual([READ_CHUNK, READ_CHUNK, 5]);
    expect(io.lineInput(1)).toBe('AAA');
    expect(io.lineInput(1).length).toBe(n - 5);
    await io.close([1]);
  });

  test('an Input file over MAX_READ_BYTES is error 7, and its handle is closed', async () => {
    const fs = new LoggingFs();
    fs.writeFile('/app/a.txt', 'x');
    fs.fioOpen = async (path: string, mode: FileMode, access: FileAccess) => ({ ...(await MemoryFs.prototype.fioOpen.call(fs, path, mode, access)), len: MAX_READ_BYTES + 1 });
    const io = new FileIO(() => fs, '/app', types);
    await expect(io.open('a.txt', 'input', '', 1)).rejects.toEqual(err(7));
    expect(fs.reads).toEqual([]);
    expect(fs.openCount).toBe(0);
  });

  test('an Open still under way when the program ends is closed, not kept', async () => {
    const fs = new LoggingFs();
    fs.writeFile('/app/a.txt', 'x');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const open = fs.fioOpen.bind(fs);
    fs.fioOpen = async (p, m, a) => { await gate; return open(p, m, a); };
    const io = new FileIO(() => fs, '/app', types);
    const pending = io.open('a.txt', 'output', '', 1);
    await new Promise(r => setTimeout(r, 0));
    await io.closeAll();
    release();
    await expect(pending).rejects.toEqual(err(52));
    await new Promise(r => setTimeout(r, 0));
    expect(fs.openCount).toBe(0);
    await expect(io.open('a.txt', 'output', '', 2)).rejects.toEqual(err(52));
  });

  test('a new program resets the backend files once, after the previous program has closed its files', async () => {
    const fs = new LoggingFs();
    fs.mkdirs('/app');
    const first = new FileIO(() => fs, '/app', types);
    await first.open('a.txt', 'output', '', 1);
    first.writeText(1, 'hello', 5);
    fs.log = [];
    // the earlier run ends; its close is still on its way when the next run opens a file
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const close = fs.fioClose.bind(fs);
    fs.fioClose = async id => { await gate; return close(id); };
    void first.closeAll();
    const second = new FileIO(() => fs, '/app', types);
    const opening = second.open('b.txt', 'output', '', 1);
    await new Promise(r => setTimeout(r, 0));
    expect(fs.log).toEqual([]);
    release();
    await opening;
    await second.open('c.txt', 'output', '', 2);
    expect(fs.log).toEqual(['close 1', 'reset']);
    expect(fs.readFile('/app/a.txt')).toBe('hello');
    await second.closeAll();
  });
});
