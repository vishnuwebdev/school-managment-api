import type { Response } from 'express';

/** Sends a generated PDF to open in the browser (or save) under a safe file name. */
export function sendPdf(res: Response, f: { data: Buffer; filename: string }) {
  res
    .status(200)
    .set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(f.data.length),
      'Content-Disposition': `inline; filename="${f.filename.replace(/[^\w.\- ]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .end(f.data);
  return undefined;
}
