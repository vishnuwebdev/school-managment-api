/** Shared checks for uploaded files: what the bytes really are, never what the client claims. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const DOCUMENT_TYPES = [...IMAGE_TYPES, 'application/pdf'] as const;
/** Every type the raw-body parser accepts for uploads. */
export const UPLOAD_CONTENT_TYPES = [...DOCUMENT_TYPES, 'image/svg+xml'];

export const EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
};

export function sniffFile(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  const head = buf.subarray(0, 2048).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg')))
    return 'image/svg+xml';
  return null;
}

/** SVG can carry script. Anything active is refused rather than "cleaned". */
export const UNSAFE_SVG =
  /<\s*(script|foreignObject|iframe|object|embed)\b|\son[a-z]+\s*=|javascript:|<!ENTITY|<!DOCTYPE[^>]*\[|(?:xlink:)?href\s*=\s*["']\s*(?:https?:|data:text)/i;
