import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
export class LocalDiskStorage {
    driver = 'local';
    root;
    constructor(dir) {
        this.root = resolve(dir);
    }
    /** Resolves a key under the root and refuses anything that escapes it. */
    pathOf(key) {
        const full = resolve(this.root, key);
        if (!full.startsWith(this.root + sep))
            throw new Error('Invalid storage key');
        return full;
    }
    async put(key, data) {
        const full = this.pathOf(key);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, data, { flag: 'wx' });
    }
    async get(key) {
        try {
            return await readFile(this.pathOf(key));
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return null;
            throw err;
        }
    }
    async delete(key) {
        await rm(this.pathOf(key), { force: true });
    }
}
/** In-memory driver for tests. */
export class MemoryStorage {
    driver = 'memory';
    objects = new Map();
    async put(key, data) {
        this.objects.set(key, data);
    }
    async get(key) {
        return this.objects.get(key) ?? null;
    }
    async delete(key) {
        this.objects.delete(key);
    }
}
export function createStorage(env) {
    if (env.STORAGE_DRIVER === 's3') {
        throw new Error('STORAGE_DRIVER=s3 is not implemented yet. Use STORAGE_DRIVER=local.');
    }
    return new LocalDiskStorage(env.STORAGE_DIR);
}
