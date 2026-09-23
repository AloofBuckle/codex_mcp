/** Project-confined output paths; never follow a page-supplied symlink. */
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './errors.mjs';
export function confinedDirectory(requested, roots) {
  const target = path.resolve(requested);
  const root = roots
    .map((r) => path.resolve(r))
    .find((r) => target === r || target.startsWith(r + path.sep));
  if (!root)
    throw new ValidationError(
      'Output directory must remain inside the configured project tmp/output directory',
    );
  let cursor = path.parse(target).root;
  for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor)) {
      const st = fs.lstatSync(cursor);
      if (st.isSymbolicLink() || !st.isDirectory())
        throw new ValidationError('Output directory contains a symlink or non-directory');
    } else fs.mkdirSync(cursor, { mode: 0o700 });
  }
  return target;
}
export function exclusiveWrite(file, bytes) {
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return file;
}

/** Fetch only explicitly requested/observed HTTP assets using profile cookies.
 * Bounds apply while streaming, not after buffering an unbounded response.
 * Redirects are restricted to the same origin; no Cookie forwarding elsewhere.
 */
export async function fetchSessionBytes(
  context,
  url,
  { maxBytes = 64 * 1024 * 1024, timeout = 30000, referer, allowRedirect } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new ValidationError('maxBytes must be a non-negative safe integer');
  const original = new URL(url);
  if (!['http:', 'https:'].includes(original.protocol) || original.username || original.password)
    throw new ValidationError('Asset downloads require ordinary http(s) URLs');
  let next = original;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    for (let i = 0; i < 6; i++) {
      const cookies = await context.cookies(next.href);
      const headers = {};
      if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      if (referer && new URL(referer).origin === next.origin) headers.Referer = referer;
      const response = await fetch(next, {
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location') || '';
        await response.body?.cancel().catch(() => {});
        const redirect = new URL(location, next);
        if (
          !['http:', 'https:'].includes(redirect.protocol) ||
          redirect.username ||
          redirect.password
        )
          throw new ValidationError('Invalid asset redirect URL');
        if (redirect.origin !== original.origin && !allowRedirect?.(redirect, original))
          throw new ValidationError(
            'Cross-origin asset redirect requires a separately observed URL',
          );
        next = redirect;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`HTTP ${response.status}`), {
          status: response.status,
          url: next.href,
        });
      }
      const stated = Number(response.headers.get('content-length') || 0);
      if (stated > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Asset exceeds maximum ${maxBytes} bytes`);
      }
      const chunks = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > maxBytes) {
            controller.abort();
            throw new Error(`Asset exceeds maximum ${maxBytes} bytes`);
          }
          chunks.push(Buffer.from(chunk));
        }
      return {
        bytes: Buffer.concat(chunks, size),
        contentType: response.headers.get('content-type') || '',
        status: response.status,
        url: next.href,
      };
    }
    throw new Error('Asset redirect limit exceeded');
  } finally {
    clearTimeout(timer);
  }
}
