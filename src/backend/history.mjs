/**
 * Browsing history for OUR dedicated profile only.
 *
 * Google Chrome stores history in an SQLite database inside the profile; node:sqlite
 * reads a copy of it (read-only, never the user's profile). Session visits are
 * also recorded in memory so filtering works even before a flush.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../util/errors.mjs';

const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000;

export class HistoryStore {
  constructor(manager) {
    this.manager = manager;
    this.session = [];
    this.limit = 2000;
    this.sqliteWarned = false;
  }

  record({ url, title, ts = Date.now(), source = 'session' }) {
    if (!url || url === 'about:blank') return;
    const entry = { url, title: title ?? '', ts, source };
    this.session = this.session.filter((item) => item.url !== url || Math.abs(item.ts - ts) > 1000);
    this.session.unshift(entry);
    if (this.session.length > this.limit) this.session.length = this.limit;
  }

  async query(options = {}) {
    const limit = Number(options.limit ?? 50);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000)
      throw new ValidationError('history limit must be an integer between 1 and 1000');
    const keyword = options.keyword ? String(options.keyword).toLowerCase() : null;
    const from = toTimestamp(options.from ?? options.since);
    const to = toTimestamp(options.to ?? options.until);
    const profileEntries = await this.#readProfileHistory({ limit, keyword, from, to });
    const merged = new Map();
    for (const entry of [...profileEntries, ...this.session]) {
      const key = `${entry.url}|${Math.round(entry.ts / 60000)}`;
      if (!merged.has(key)) merged.set(key, entry);
    }
    const filtered = [...merged.values()]
      .filter((entry) =>
        keyword ? `${entry.url} ${entry.title}`.toLowerCase().includes(keyword) : true,
      )
      .filter((entry) => (from !== null ? entry.ts >= from : true))
      .filter((entry) => (to !== null ? entry.ts <= to : true))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, limit);
    return {
      entries: filtered,
      scope: 'dedicated profile + this session only (never the user profile)',
      profileDatabase: this.lastProfilePath ?? null,
    };
  }

  resolveProfileHistoryPath() {
    const dir = this.manager.profileDir;
    const candidates = [path.join(dir, 'Default', 'History'), path.join(dir, 'History')];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  async #readProfileHistory({ limit, keyword, from, to }) {
    const source = this.resolveProfileHistoryPath();
    if (!source) return [];
    this.lastProfilePath = source;
    let copy;
    try {
      const tmp = path.join(
        this.manager.config.tmpDir,
        `history-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
      );
      fs.mkdirSync(path.dirname(tmp), { recursive: true, mode: 0o700 });
      await fs.promises.copyFile(source, tmp);
      copy = tmp;
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(tmp, { readOnly: true });
      try {
        const conditions = [],
          values = [];
        if (from !== null) {
          conditions.push('last_visit_time >= ?');
          values.push((from + CHROMIUM_EPOCH_OFFSET_MS) * 1000);
        }
        if (to !== null) {
          conditions.push('last_visit_time <= ?');
          values.push((to + CHROMIUM_EPOCH_OFFSET_MS) * 1000);
        }
        const query = `SELECT url, title, last_visit_time, visit_count FROM urls ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY last_visit_time DESC`;
        const rows = [];
        // Stream rows until there are enough matches. Filtering before the
        // limit preserves Unicode/literal substring semantics without loading
        // the entire history into memory or hiding older matches.
        const statement = db.prepare(query);
        // Chrome stores microseconds since 1601, beyond Number.MAX_SAFE_INTEGER.
        statement.setReadBigInts(true);
        let inspected = 0;
        for (const row of statement.iterate(...values)) {
          if (++inspected % 256 === 0) await new Promise((resolve) => setImmediate(resolve));
          if (keyword && !`${row.url} ${row.title ?? ''}`.toLowerCase().includes(keyword)) continue;
          rows.push({
            url: row.url,
            title: row.title ?? '',
            ts: Number(row.last_visit_time) / 1000 - CHROMIUM_EPOCH_OFFSET_MS,
            visitCount: Number(row.visit_count ?? 0),
            source: 'profile',
          });
          if (rows.length >= limit) break;
        }
        return rows;
      } finally {
        db.close();
      }
    } catch (error) {
      if (!this.sqliteWarned) {
        this.sqliteWarned = true;
        this.manager.logger.warn(`history database read unavailable: ${error.message}`);
      }
      return [];
    } finally {
      if (copy) fs.rmSync(copy, { force: true });
    }
  }
}

function toTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
