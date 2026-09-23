/** Observed page resources only; authenticated bounded downloads to confined paths. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { kHandle } from '../../util/value.mjs';
import { UnsupportedError, ValidationError } from '../../util/errors.mjs';
import { safeFilename, sha256, uniqueName } from '../../util/format.mjs';
import { confinedDirectory, exclusiveWrite, fetchSessionBytes } from '../../util/filesystem.mjs';

export class PageAssetsCapability {
  constructor(tab) {
    this[kHandle] = { kind: 'capability' };
    Object.defineProperty(this, 'tab', { value: tab });
    this.name = 'pageAssets';
    this.kind = 'page';
  }
  documentation() {
    return {
      name: 'pageAssets',
      methods: {
        list: 'list({type?,includeDataUrls?}?) -> actual observed resources',
        bundle:
          'bundle({urls?,types?,limit?,maxBytes?,maxBundleBytes?,directory?}?) -> {directory,files,skipped,totalBytes}',
      },
      semantics: [
        'Only URLs already observed by this tab are eligible.',
        'Downloads reuse the dedicated browser profile cookies and make bounded GET requests; redirects stay on the original origin.',
        'Outputs stay within project tmpDir/outputDir. Symlinks and existing filenames are never overwritten.',
        'Failures and size limits are reported per resource; files are real and include SHA-256 hashes.',
      ],
    };
  }
  async list(options = {}) {
    return this.tab.requestLog
      .all()
      .filter(
        (r) =>
          (!options.type || r.resourceType === options.type) &&
          (options.includeDataUrls || !r.url.startsWith('data:')),
      );
  }
  async bundle(options = {}) {
    const config = this.tab.manager.config;
    const limit = Number(options.limit ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000)
      throw new ValidationError('limit must be an integer between 1 and 2000');
    for (const k of ['urls', 'types'])
      if (
        options[k] !== undefined &&
        (!Array.isArray(options[k]) || options[k].some((x) => typeof x !== 'string'))
      )
        throw new ValidationError(`${k} must be an array of strings`);
    const maxBytes = Number(options.maxBytes ?? config.security.maxAssetBytes);
    const maxTotal = Number(options.maxBundleBytes ?? config.security.maxBundleBytes);
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > config.security.maxAssetBytes ||
      !Number.isSafeInteger(maxTotal) ||
      maxTotal < 1 ||
      maxTotal > config.security.maxBundleBytes
    )
      throw new ValidationError(
        'Requested byte limits must be positive and may not exceed host limits',
      );
    const unique = new Map(this.tab.requestLog.all().map((r) => [r.url, r]));
    const wanted = new Set(options.urls || []),
      types = new Set(options.types || []);
    if ([...wanted].some((url) => !unique.has(url)))
      throw new ValidationError('Every requested URL must have been observed by this tab');
    const selected = [...unique.values()]
      .filter(
        (r) => (!wanted.size || wanted.has(r.url)) && (!types.size || types.has(r.resourceType)),
      )
      .slice(0, limit);
    if (!selected.length)
      throw new UnsupportedError('No observed resources matched the requested bundle');
    const directory = confinedDirectory(
      options.directory ||
        path.join(config.tmpDir, 'page-assets', `${this.tab.id}-${crypto.randomUUID()}`),
      [config.tmpDir, config.outputDir],
    );
    const names = new Set(fs.readdirSync(directory)),
      files = [],
      skipped = [];
    let totalBytes = 0;
    for (const resource of selected) {
      try {
        let bytes,
          contentType,
          status = 200;
        if (resource.url.startsWith('data:')) {
          const comma = resource.url.indexOf(',');
          const meta = resource.url.slice(5, comma),
            body = resource.url.slice(comma + 1);
          if (body.length > Math.min(maxBytes, maxTotal - totalBytes) * 4)
            throw new Error('Data URL exceeds byte limit');
          bytes = meta.includes(';base64')
            ? Buffer.from(body, 'base64')
            : Buffer.from(decodeURIComponent(body));
          contentType = meta.split(';')[0];
        } else {
          const result = await fetchSessionBytes(this.tab.context, resource.url, {
            maxBytes: Math.min(maxBytes, maxTotal - totalBytes),
            referer: this.tab.page.url(),
          });
          ({ bytes, contentType, status } = result);
        }
        if (bytes.length > maxBytes || totalBytes + bytes.length > maxTotal)
          throw new Error('Asset or bundle byte limit exceeded');
        let proposed = 'inline.bin';
        try {
          proposed = path.basename(new URL(resource.url).pathname) || 'asset.bin';
        } catch {}
        const name = uniqueName(safeFilename(proposed, { fallback: 'asset.bin' }), names);
        const file = exclusiveWrite(path.join(directory, name), bytes);
        totalBytes += bytes.length;
        files.push({
          url: resource.url,
          resourceType: resource.resourceType,
          file,
          bytes: bytes.length,
          sha256: sha256(bytes),
          contentType,
          status,
        });
      } catch (error) {
        skipped.push({
          url: resource.url,
          resourceType: resource.resourceType,
          reason: error.message,
        });
      }
    }
    return { directory, files, skipped, totalBytes };
  }
}
