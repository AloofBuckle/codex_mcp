/**
 * Content export helpers.
 *
 * - export(): real local files (Markdown + HTML) using a small built-in
 *   HTML→Markdown converter (headings, links, lists, code, quotes, simple tables).
 * - exportGsuite(): verifies the Google Workspace URL and uses the native export
 *   endpoints with the profile's authenticated session; without credentials this
 *   returns a typed auth_required error (documented as untested here).
 * - exportYouTubeTranscript(): reads page-visible caption tracks and downloads
 *   the real timedtext payload; explicit error when captions are unavailable.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { confinedDirectory, exclusiveWrite, fetchSessionBytes } from '../util/filesystem.mjs';
import { AuthRequiredError, UnsupportedError, ValidationError } from '../util/errors.mjs';
import { safeFilename, sha256, slugify, timestampSlug } from '../util/format.mjs';

const GSUITE_HOSTS = new Set(['docs.google.com', 'drive.google.com']);
const GSUITE_KINDS = {
  '/document/': {
    kind: 'document',
    types: { pdf: 'pdf', docx: 'docx', md: 'txt', html: 'html', txt: 'txt' },
  },
  '/spreadsheets/': {
    kind: 'spreadsheet',
    types: { pdf: 'pdf', xlsx: 'xlsx', csv: 'csv', md: 'csv' },
  },
  '/presentation/': { kind: 'presentation', types: { pdf: 'pdf', pptx: 'pptx' } },
};

export function detectGsuiteTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    !GSUITE_HOSTS.has(parsed.hostname) ||
    parsed.username ||
    parsed.password
  )
    return null;
  const match = parsed.pathname.match(
    /^\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{10,})/,
  );
  if (!match) return null;
  const prefix = `/${match[1]}/`;
  const meta = GSUITE_KINDS[prefix];
  if (!meta) return null;
  return {
    docType: match[1],
    id: match[2],
    kind: meta.kind,
    supportedTypes: Object.keys(meta.types),
    exportFormat: meta.types,
    url: parsed.toString(),
  };
}

export async function exportPage(tab, ctx, options = {}) {
  const format = options.format ?? 'md';
  if (!['md', 'html', 'both'].includes(format))
    throw new ValidationError('export format must be md, html or both');
  const data = await tab.page.evaluate((selector) => {
    const root = selector
      ? document.querySelector(selector)
      : (document.querySelector('main, article, [role="main"]') ?? document.body);
    return {
      title: document.title,
      url: location.href,
      html: root ? root.innerHTML : '',
      text: root ? root.innerText : '',
    };
  }, options.selector ?? null);
  const slug = slugify(options.name ?? data.title ?? 'page');
  const dir = confinedDirectory(path.join(tab.manager.config.outputDir, 'content'), [
    tab.manager.config.outputDir,
  ]);
  const stamp = `${timestampSlug()}-${crypto.randomUUID().slice(0, 8)}`;
  const files = [];
  if (format === 'md' || format === 'both') {
    const markdown = `# ${data.title || slug}\n\n> source: ${data.url}\n> exported: ${new Date().toISOString()}\n\n${htmlToMarkdown(data.html)}`;
    const file = path.join(dir, `${stamp}-${safeFilename(slug, { fallback: 'page' })}.md`);
    exclusiveWrite(file, markdown);
    files.push({
      file,
      kind: 'markdown',
      bytes: Buffer.byteLength(markdown),
      sha256: sha256(markdown),
    });
  }
  if (format === 'html' || format === 'both') {
    const html = `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(data.title)}</title></head><body>${data.html}</body></html>`;
    const file = path.join(dir, `${stamp}-${safeFilename(slug, { fallback: 'page' })}.html`);
    exclusiveWrite(file, html);
    files.push({ file, kind: 'html', bytes: Buffer.byteLength(html), sha256: sha256(html) });
  }
  return {
    title: data.title,
    url: data.url,
    files,
    textChars: data.text.length,
    converter: 'built-in html→markdown (headings, links, lists, code, quotes, simple tables)',
  };
}

export async function exportGsuite(tab, ctx, type, options = {}) {
  const target = detectGsuiteTarget(tab.page.url());
  if (!target || !options.ignoreUrlCheck) {
    if (!target) {
      throw new ValidationError(
        'exportGsuite requires a verified Google Workspace document URL (docs.google.com/document|spreadsheets|presentation/d/<id>)',
        { url: tab.page.url() },
      );
    }
  }
  const ext = target.exportFormat[type];
  if (!ext) {
    throw new UnsupportedError(
      `type ${JSON.stringify(type)} is not supported for Google ${target.kind}s`,
      { supported: target.supportedTypes },
    );
  }
  const exportUrl = `https://docs.google.com/${target.docType}/d/${target.id}/export?format=${ext}`;
  let response;
  try {
    response = await fetchSessionBytes(tab.context, exportUrl, {
      maxBytes: tab.manager.config.security.maxAssetBytes,
      timeout: options.timeout ?? 120000,
      allowRedirect: (next) =>
        next.protocol === 'https:' &&
        /(^|\.)(google\.com|googleusercontent\.com)$/.test(next.hostname),
    });
  } catch (error) {
    if (error.status === 401 || error.status === 403)
      throw new AuthRequiredError(
        `Google export returned HTTP ${error.status}; sign in to the dedicated profile`,
        { exportUrl, status: error.status },
      );
    throw error;
  }
  const finalUrl = response.url;
  const contentType = response.contentType;
  if (
    /accounts\.google\.com|ServiceLogin/i.test(finalUrl) ||
    (contentType.includes('text/html') && ext !== 'html')
  ) {
    throw new AuthRequiredError(
      'Google returned a sign-in page instead of the export; sign in to the dedicated profile through the GUI, then retry',
      { finalUrl },
    );
  }
  const buffer = response.bytes;
  if (buffer.length > tab.manager.config.security.maxAssetBytes)
    throw new ValidationError('Google export exceeds configured file size limit');
  if (['docx', 'xlsx', 'pptx'].includes(type) && !buffer.subarray(0, 2).equals(Buffer.from('PK')))
    throw new UnsupportedError('Google response is not an Office Open XML ZIP container');
  if (type === 'pdf' && !buffer.subarray(0, 5).equals(Buffer.from('%PDF-')))
    throw new UnsupportedError('Google response is not a PDF');
  if (!buffer.length) throw new UnsupportedError('Google export returned an empty body');
  const dir = confinedDirectory(path.join(tab.manager.config.outputDir, 'gsuite'), [
    tab.manager.config.outputDir,
  ]);
  const slug = slugify(options.name ?? `${target.kind}-${target.id.slice(0, 8)}`);
  const realExt = type === 'md' ? 'md' : ext;
  let payload = buffer;
  let note;
  if (type === 'md') {
    const text = buffer.toString('utf8');
    payload = Buffer.from(
      target.kind === 'spreadsheet' ? csvToMarkdown(text) : `# ${slug}\n\n${text}`,
    );
    note =
      target.kind === 'spreadsheet'
        ? 'markdown table generated from the real CSV export endpoint'
        : 'plain-text export converted to markdown; rich formatting is not preserved';
  }
  const file = path.join(
    dir,
    `${timestampSlug()}-${crypto.randomUUID()}-${safeFilename(options.name ?? slug, { fallback: 'export' })}.${realExt}`,
  );
  exclusiveWrite(file, payload);
  return {
    docType: target.docType,
    exportType: type,
    requestedFormat: ext,
    file,
    bytes: payload.length,
    sha256: sha256(payload),
    contentType,
    finalUrl,
    ...(note ? { note } : {}),
    authNote:
      'Live authenticated Google Workspace export has not been verified in this environment; URL/format validation is covered by local tests.',
  };
}

export async function exportYouTubeTranscript(tab, ctx, options = {}) {
  const url = tab.page.url();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('current tab URL is not parseable');
  }
  if (!/(^|\.)youtube\.com$/.test(parsed.hostname) && parsed.hostname !== 'youtu.be') {
    throw new ValidationError('exportYouTubeTranscript requires a YouTube watch page');
  }
  const tracks = await tab.page
    .evaluate(() => {
      const response =
        window.ytInitialPlayerResponse ?? window.ytplayer?.config?.args?.player_response ?? null;
      const parsedResponse = typeof response === 'string' ? JSON.parse(response) : response;
      const list = parsedResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      return list.map((track) => ({
        baseUrl: track.baseUrl,
        languageCode: track.languageCode,
        name: track.name?.simpleText ?? track.name?.runs?.[0]?.text ?? track.languageCode,
        kind: track.kind ?? 'manual',
        isTranslatable: Boolean(track.isTranslatable),
      }));
    })
    .catch(() => null);
  if (!tracks) {
    throw new UnsupportedError('no page-visible YouTube player response with captions was found');
  }
  if (!tracks.length)
    throw new UnsupportedError('this YouTube video exposes no caption tracks to the page');
  const track = options.language
    ? (tracks.find((item) => item.languageCode === options.language) ??
      (() => {
        throw new UnsupportedError(`no caption track for language ${options.language}`, {
          available: tracks.map((t) => t.languageCode),
        });
      })())
    : (tracks.find((item) => item.kind !== 'asr') ?? tracks[0]);
  const transcriptUrl = `${track.baseUrl}${track.baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
  const captionTarget = new URL(transcriptUrl);
  if (
    captionTarget.protocol !== 'https:' ||
    !/(^|\.)youtube\.com$/.test(captionTarget.hostname) ||
    captionTarget.pathname !== '/api/timedtext'
  )
    throw new ValidationError(
      'Caption resource must be a verified YouTube timedtext HTTPS endpoint',
    );
  const response = await fetchSessionBytes(tab.context, transcriptUrl, {
    timeout: options.timeout ?? 60000,
    maxBytes: tab.manager.config.security.maxAssetBytes,
    referer: url,
  });
  let payload;
  try {
    payload = JSON.parse(response.bytes.toString('utf8'));
  } catch {
    throw new UnsupportedError('Caption endpoint did not return JSON');
  }
  const segments = (payload?.events ?? [])
    .filter((event) => Array.isArray(event.segs))
    .map((event) => ({
      start: (event.tStartMs ?? 0) / 1000,
      text: event.segs
        .map((seg) => seg.utf8 ?? '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim(),
    }))
    .filter((segment) => segment.text.length > 0);
  if (!segments.length) throw new UnsupportedError('caption track was empty');
  const dir = confinedDirectory(path.join(tab.manager.config.outputDir, 'youtube'), [
    tab.manager.config.outputDir,
  ]);
  const title = await tab.page.title();
  const body = `${segments.map((segment) => `[${formatTime(segment.start)}] ${segment.text}`).join('\n')}\n`;
  const file = path.join(
    dir,
    `${timestampSlug()}-${safeFilename(slugify(title), { fallback: 'transcript' })}.md`,
  );
  exclusiveWrite(file, `# ${title}\n\n> ${url}\n\n${body}`);
  return {
    file,
    language: track.languageCode,
    captionKind: track.kind,
    availableTracks: tracks.map((item) => ({
      language: item.languageCode,
      name: item.name,
      kind: item.kind,
    })),
    segments: segments.length,
    chars: body.length,
    bytes: Buffer.byteLength(body),
    note: 'Real caption track downloaded from the page-visible baseUrl; YouTube network behavior is labeled untested in this environment.',
  };
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h > 0 ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function htmlToMarkdown(html) {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');
  for (let level = 1; level <= 6; level += 1) {
    const hashes = '#'.repeat(level);
    text = text.replace(
      new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'gi'),
      (_, inner) => `\n\n${hashes} ${stripTags(inner).trim()}\n\n`,
    );
  }
  text = text.replace(
    /<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, __, inner) => `**${stripTags(inner).trim()}**`,
  );
  text = text.replace(
    /<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, __, inner) => `*${stripTags(inner).trim()}*`,
  );
  text = text.replace(
    /<code[^>]*>([\s\S]*?)<\/code>/gi,
    (_, inner) => `\`${stripTags(inner).trim()}\``,
  );
  text = text.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    (_, inner) => `\n\n\`\`\`\n${stripTags(inner).replace(/\n+$/, '')}\n\`\`\`\n\n`,
  );
  text = text.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_, inner) =>
      `\n\n${stripTags(inner)
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`,
  );
  text = text.replace(
    /<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi,
    (_, alt, src) => `![${alt}](${src})`,
  );
  text = text.replace(
    /<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi,
    (_, src, alt) => `![${alt}](${src})`,
  );
  text = text.replace(
    /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, inner) => `[${stripTags(inner).trim() || href}](${href})`,
  );
  text = text.replace(/<table[\s\S]*?<\/table>/gi, (table) => `\n\n${tableToMarkdown(table)}\n\n`);
  text = text.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (_, inner) => `- ${stripTags(inner).trim()}\n`,
  );
  text = text.replace(/<\/(p|div|section|article|header|footer|main|tr|ul|ol|dl)>/gi, '\n\n');
  text = stripTags(text);
  text = decodeEntities(text);
  text = text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function tableToMarkdown(table) {
  const rows = [...String(table).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) =>
      [...match[1].matchAll(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi)].map((cell) =>
        stripTags(cell[2]).replace(/\|/g, '\\|').trim(),
      ),
    )
    .filter((row) => row.length);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row) => [...row, ...Array.from({ length: width - row.length }, () => '')];
  const [head, ...rest] = rows;
  return [
    `| ${pad(head).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...rest.map((row) => `| ${pad(row).join(' | ')} |`),
  ].join('\n');
}

function csvToMarkdown(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row) => [...row, ...Array.from({ length: width - row.length }, () => '')];
  const [head, ...rest] = rows;
  return [
    `| ${pad(head).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...rest.map((row) => `| ${pad(row).join(' | ')} |`),
  ].join('\n');
}

export function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const text = String(input ?? '');
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim().length));
}

function stripTags(value) {
  return String(value ?? '').replace(/<[^>]+>/g, '');
}

function decodeEntities(value) {
  const entities = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    '#39': "'",
    '#34': '"',
    '#38': '&',
  };
  return String(value ?? '').replace(/&(#?\w+);/g, (match, code) => {
    if (entities[code] !== undefined) return entities[code];
    if (/^#\d+$/.test(code)) return String.fromCodePoint(Number(code.slice(1)));
    if (/^#x[0-9a-f]+$/i.test(code))
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    return match;
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char],
  );
}
