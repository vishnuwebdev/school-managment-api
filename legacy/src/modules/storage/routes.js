import { Router } from 'express';
import multer from 'multer';
import { authenticate, tenantScope, permit } from '../../core/middleware.js';
import { asyncRoute, badRequest, notFound } from '../../core/errors.js';
import { db } from '../../db/index.js';
import { storage } from './localStorageAdapter.js';

// 10MB cap: generous for a birth certificate scan or a report-card PDF
// without letting a single request exhaust memory (multer buffers to RAM
// here; a high-volume deployment should switch to disk/stream storage).
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

export const documentsRouter = Router();

documentsRouter.get('/', authenticate, tenantScope, permit('documents.view'), asyncRoute(async (req, res) => {
  const { entityType, entityId } = req.query;
  if (!entityType || !entityId) throw badRequest('entityType and entityId are required');
  res.json({ data: await db.documents.listForEntity(req.tenantId, entityType, entityId) });
}));

documentsRouter.post('/', authenticate, tenantScope, permit('documents.upload'), upload.single('file'), asyncRoute(async (req, res) => {
  const { entityType, entityId, documentType, expiryDate } = req.body || {};
  if (!req.file) throw badRequest('A file is required');
  if (![entityType, entityId, documentType].every(Boolean)) throw badRequest('entityType, entityId and documentType are required');
  const storageKey = await storage.save({
    tenantId: req.tenantId, entityType, entityId, fileName: req.file.originalname, buffer: req.file.buffer,
  });
  const document = await db.documents.create({
    tenantId: req.tenantId, entityType, entityId, documentType,
    fileName: req.file.originalname, storageKey, mimeType: req.file.mimetype, sizeBytes: req.file.size, uploadedBy: req.auth.sub,
    // Optional -- lets a compliance register (e.g. a teacher's SACE
    // registration or police clearance) flag documents nearing expiry.
    // undefined/'' from a plain multipart field both fall through to null.
    expiryDate: expiryDate || null,
  });
  await db.audit.record({ event: 'document.uploaded', actorId: req.auth.sub, target: document.id, tenantId: req.tenantId, summary: { entityType, entityId, documentType } });
  res.status(201).json({ data: document });
}));

documentsRouter.get('/:id/download', authenticate, tenantScope, permit('documents.view'), asyncRoute(async (req, res) => {
  const document = await db.documents.findById(req.tenantId, req.params.id);
  if (!document) throw notFound('Document not found');
  const buffer = await storage.read(document.storageKey);
  res.setHeader('Content-Type', document.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${document.fileName}"`);
  res.send(buffer);
}));
