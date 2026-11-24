import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { files } from '../../db/schema/index.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { EXTENSION, sniffFile, UNSAFE_SVG } from './file-validation.js';
/**
 * Upload plumbing shared by every feature that stores files (student photos and documents, and later
 * certificates). The bytes go to the storage driver first; the database row is written inside the
 * caller's transaction, so a failed transaction leaves nothing but an orphan file we delete.
 */
export class FileService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** Validates the bytes and writes them to storage. Call [discard] if the surrounding transaction fails. */
    async prepare(tenantId, data, o) {
        if (!Buffer.isBuffer(data) || data.length === 0)
            throw new ValidationError(`Send the ${o.label} as the request body with its content-type (${o.allowed.join(', ')})`);
        if (data.length > o.maxBytes)
            throw new ValidationError(`${o.label} must be smaller than ${o.maxBytes / (1024 * 1024)} MB`);
        const mime = sniffFile(data);
        if (!mime || !o.allowed.includes(mime))
            throw new ValidationError(`${o.label} must be one of: ${o.allowed.map((m) => EXTENSION[m].toUpperCase()).join(', ')}`);
        if (mime === 'image/svg+xml' && UNSAFE_SVG.test(data.toString('utf8')))
            throw new ValidationError('This SVG contains scripts or external links and cannot be used');
        const id = uuidv7();
        const key = `${tenantId}/${id}.${EXTENSION[mime]}`;
        await this.deps.storage.put(key, data);
        return {
            id,
            mime,
            size: data.length,
            checksum: createHash('sha256').update(data).digest('hex'),
            key,
            name: (o.filename ?? `${o.label}.${EXTENSION[mime]}`).slice(0, 255),
        };
    }
    async insert(tx, tenantId, purpose, f, actor) {
        await tx.insert(files).values({
            id: f.id,
            tenantId,
            purpose,
            originalName: f.name,
            mimeType: f.mime,
            sizeBytes: f.size,
            checksumSha256: f.checksum,
            storageDriver: this.deps.storage.driver,
            storageKey: f.key,
            uploadedBy: actor.userId,
        });
    }
    async supersede(tx, tenantId, fileId) {
        if (!fileId)
            return;
        await tx
            .update(files)
            .set({ supersededAt: this.deps.clock.now() })
            .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));
    }
    async discard(f) {
        await this.deps.storage.delete(f.key).catch(() => undefined);
    }
    /** Always filtered by tenant: another school's file id behaves as not found. */
    async read(tenantId, fileId) {
        const [row] = await this.deps.db
            .select()
            .from(files)
            .where(and(eq(files.id, fileId), eq(files.tenantId, tenantId)));
        if (!row)
            throw new NotFoundError('File');
        const data = await this.deps.storage.get(row.storageKey);
        if (!data)
            throw new NotFoundError('File');
        return {
            mime: row.mimeType,
            name: row.originalName,
            checksum: row.checksumSha256,
            size: row.sizeBytes,
            data,
        };
    }
}
/** Response headers for serving a stored file inline, safely. */
export function fileHeaders(f) {
    return {
        'Content-Type': f.mime,
        'Content-Length': String(f.data.length),
        ETag: `"${f.checksum}"`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Content-Disposition': `inline; filename="${f.name.replace(/[^\w.\- ]/g, '_')}"`,
    };
}
