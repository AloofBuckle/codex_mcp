/** Small formatting/redaction helpers shared by reports, files and logs. */
import fs from 'node:fs';
import crypto from 'node:crypto';

export function slugify(value, maxLength = 60) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
  return slug || 'page';
}

/**
 * Sanitize a remote filename: no separators, no traversal, no control chars.
 */
export function safeFilename(name, { fallback = 'asset', maxLength = 120 } = {}) {
  let base = String(name ?? '').split(/[?#]/)[0];
  base = base.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  base = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[:*?"<>|]/g, '_')
    .trim();
  base = base.replace(/^\.+/, '').replace(/\.{2,}/g, '.');
  if (!base) base = fallback;
  const dot = base.lastIndexOf('.');
  const ext =
    dot > 0
      ? base
          .slice(dot)
          .replace(/[^A-Za-z0-9.]/g, '')
          .slice(0, 12)
      : '';
  const stem = (dot > 0 ? base.slice(0, dot) : base).slice(0, Math.max(1, maxLength - ext.length));
  return `${stem || fallback}${ext}`;
}

export function uniqueName(name, used = new Set()) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

export function truncate(text, maxLength) {
  const value = String(text ?? '');
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 32))}\n... [truncated ${value.length - maxLength + 32} chars]`;
}

export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets)
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  out = out.replace(/([?&](?:token|access_token|api_key|key)=)[^&\s"']+/gi, '$1[redacted]');
  return out;
}

export function fileInfo(filePath, extra = {}) {
  const stat = fs.statSync(filePath);
  return { path: filePath, bytes: stat.size, ...extra };
}

export function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}
