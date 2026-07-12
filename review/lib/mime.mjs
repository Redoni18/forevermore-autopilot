// Minimal extension -> MIME-type map. No deps — the review station only ever
// serves its own static UI plus outbox assets (video/image), so the set of
// extensions it needs is small and fixed.

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

export function getMimeType(filePath) {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filePath.slice(dot).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export function isVideoMime(mime) {
  return mime.startsWith('video/');
}
