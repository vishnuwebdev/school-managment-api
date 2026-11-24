import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';

// Object-storage abstraction. Only a local-filesystem implementation exists
// today (zero signup, zero cost — matches context.md's ask for a free dev
// option), but every caller goes through this same save/read/remove
// interface, so a Cloudflare R2 or S3-compatible driver can be dropped in
// later behind OBJECT_STORAGE_DRIVER without touching the routes that call
// it. Storage keys are relative paths; nothing sensitive is served from a
// predictable public URL (spec section 51) — downloads always go through
// the authenticated /api/documents/:id/download route, never a static
// file server.
function buildKey(tenantId, entityType, entityId, fileName) {
  const ext = path.extname(fileName);
  const safeBase = crypto.randomUUID();
  return path.join(tenantId, entityType, entityId, `${safeBase}${ext}`);
}

export function createLocalStorageAdapter() {
  const root = path.resolve(env.objectStorageLocalPath);

  return {
    driver: 'local',
    async save({ tenantId, entityType, entityId, fileName, buffer }) {
      const key = buildKey(tenantId, entityType, entityId, fileName);
      const absolutePath = path.join(root, key);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, buffer);
      return key;
    },
    async read(key) {
      return fs.readFile(path.join(root, key));
    },
    async remove(key) {
      await fs.rm(path.join(root, key), { force: true });
    },
  };
}

export const storage = createLocalStorageAdapter();
