import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { Readable } from 'stream';

/** Where uploaded bytes live. Metadata, ownership and authorization are in the
 * database + routes, never here, so swapping to R2/S3 later means writing one
 * more class that implements this interface. */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  createReadStream(key: string): Readable;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** Removes everything under a "directory" key, e.g. `events/<eventId>`. */
  removePrefix(prefix: string): Promise<void>;
}

// lowercase letters, digits, '-', '_', '.', and '/' between segments; no empty,
// '.' or '..' segments, no leading slash
const SAFE_KEY = /^[a-z0-9][a-z0-9_.-]*(\/[a-z0-9][a-z0-9_.-]*)*$/;

export class LocalDiskDriver implements StorageDriver {
  private readonly root: string;

  constructor(baseDir: string) {
    this.root = path.resolve(baseDir);
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private resolve(key: string): string {
    if (!SAFE_KEY.test(key) || key.split('/').some(seg => seg === '..' || seg === '.')) {
      throw new Error('invalid_storage_key');
    }
    const full = path.resolve(this.root, key);
    // defence in depth: the resolved path must stay inside the root
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error('invalid_storage_key');
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const dest = this.resolve(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    // write-then-rename so a crash never leaves a half-written file under the real key
    const tmp = `${dest}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, data, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(tmp, dest);
  }

  createReadStream(key: string): Readable {
    return fs.createReadStream(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.promises.access(this.resolve(key), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await fs.promises.rm(this.resolve(key), { force: true });
  }

  async removePrefix(prefix: string): Promise<void> {
    const dir = this.resolve(prefix);
    if (dir === this.root) throw new Error('invalid_storage_key'); // never wipe the root
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
