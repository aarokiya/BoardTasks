import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write temp → fsync → rename, so a crash never leaves a truncated file. */
export function atomicWrite(path: string, data: Buffer | string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
