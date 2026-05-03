import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { initDb, closeDb, setActiveTenant } from '../../src/db.js';
// CJS interop — script intentionally exports its core logic
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fingerprint, dedupeProject, bucketByFingerprint } = require('../../scripts/dedupe-elements.cjs');
import Database from 'better-sqlite3';

let dbPath: string;
let db: any;

function insertElement(rawDb: any, projectId: string, id: string, type: string, x: number, y: number, w: number, h: number, text: string | null, syncVersion: number) {
  const data: any = { type, x, y, width: w, height: h };
  if (text) data.text = text;
  const now = new Date().toISOString();
  rawDb.prepare(
    'INSERT INTO elements (id, project_id, type, data, label_text, created_at, updated_at, version, is_deleted, sync_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?)'
  ).run(id, projectId, type, JSON.stringify(data), text, now, now, syncVersion);
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `excalidraw-dedupe-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  setActiveTenant('default');
  closeDb();
  db = new Database(dbPath);
});

afterEach(() => {
  try { db?.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe('dedupe script', () => {
  it('fingerprint matches deriveContentId format (12 hex chars)', () => {
    const fp = fingerprint('proj', 'rectangle', 100, 100, 200, 100, 'X', '', '');
    expect(fp).toHaveLength(12);
    expect(fp).toMatch(/^[a-f0-9]+$/);
  });

  it('bucketByFingerprint groups same content', () => {
    const rows = [
      { id: 'a', sync_version: 1, type: 'rectangle', data: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 50, height: 50, text: 'Foo' }) },
      { id: 'b', sync_version: 2, type: 'rectangle', data: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 50, height: 50, text: 'Foo' }) },
      { id: 'c', sync_version: 3, type: 'rectangle', data: JSON.stringify({ type: 'rectangle', x: 100, y: 0, width: 50, height: 50, text: 'Foo' }) },
    ];
    const { groups, totalDups } = bucketByFingerprint(rows, 'p');
    expect(totalDups).toBe(1);
    const buckets = Object.values(groups) as any[];
    expect(buckets.find(g => g.length > 1).length).toBe(2);
  });

  it('dry-run reports counts without mutating', () => {
    insertElement(db, 'default', 'a', 'rectangle', 0, 0, 50, 50, 'X', 1);
    insertElement(db, 'default', 'b', 'rectangle', 0, 0, 50, 50, 'X', 2);
    insertElement(db, 'default', 'c', 'rectangle', 100, 0, 50, 50, 'Y', 3);

    const res = dedupeProject(db, 'default', false);
    expect(res.dupGroups).toBe(1);
    expect(res.softDeleted).toBe(1);
    // Confirm nothing changed
    const stillActive = db.prepare('SELECT COUNT(*) as c FROM elements WHERE project_id = ? AND is_deleted = 0').get('default').c;
    expect(stillActive).toBe(3);
  });

  it('execute soft-deletes dupes, keeps lowest sync_version, bumps survivor', () => {
    insertElement(db, 'default', 'a', 'rectangle', 0, 0, 50, 50, 'X', 1);
    insertElement(db, 'default', 'b', 'rectangle', 0, 0, 50, 50, 'X', 2);
    insertElement(db, 'default', 'c', 'rectangle', 0, 0, 50, 50, 'X', 3);

    const res = dedupeProject(db, 'default', true);
    expect(res.softDeleted).toBe(2);

    const aliveIds = db.prepare('SELECT id FROM elements WHERE project_id = ? AND is_deleted = 0').all('default').map((r: any) => r.id);
    expect(aliveIds).toEqual(['a']);

    const projSv = db.prepare('SELECT sync_version FROM projects WHERE id = ?').get('default').sync_version;
    const aSv = db.prepare('SELECT sync_version FROM elements WHERE id = ?').get('a').sync_version;
    expect(projSv).toBeGreaterThan(0);
    // Survivor stamped with the latest project sync_version so connected
    // browsers pick it up via getChangesSince.
    expect(aSv).toBe(projSv);
  });

  it('re-run after execute is a no-op', () => {
    insertElement(db, 'default', 'a', 'rectangle', 0, 0, 50, 50, 'X', 1);
    insertElement(db, 'default', 'b', 'rectangle', 0, 0, 50, 50, 'X', 2);

    dedupeProject(db, 'default', true);
    const res2 = dedupeProject(db, 'default', true);
    expect(res2.softDeleted).toBe(0);
    expect(res2.dupGroups).toBe(0);
  });
});
