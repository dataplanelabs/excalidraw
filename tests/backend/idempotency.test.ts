import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { initDb, closeDb, setActiveTenant, getAllElements, ensureTenant, getDefaultProjectForTenant } from '../../src/db.js';

let dbPath: string;
let app: any;
let deriveContentId: (...args: any[]) => string;

beforeEach(async () => {
  dbPath = path.join(os.tmpdir(), `excalidraw-idem-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  initDb(dbPath);
  setActiveTenant('default');
  const mod = await import('../../src/server.js');
  app = mod.default;
  deriveContentId = mod.deriveContentId;
});

afterEach(() => {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + suffix); } catch {}
  }
});

describe('deriveContentId (pure)', () => {
  it('is deterministic for identical inputs', () => {
    const a = deriveContentId('p', 'rectangle', 100, 100, 200, 100, 'Foo', '', '');
    const b = deriveContentId('p', 'rectangle', 100, 100, 200, 100, 'Foo', '', '');
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
    expect(a).toMatch(/^[a-f0-9]+$/);
  });

  it('changes when any input changes', () => {
    const base = deriveContentId('p', 'rectangle', 100, 100, 200, 100, 'Foo', '', '');
    expect(deriveContentId('q', 'rectangle', 100, 100, 200, 100, 'Foo', '', '')).not.toBe(base);
    expect(deriveContentId('p', 'ellipse', 100, 100, 200, 100, 'Foo', '', '')).not.toBe(base);
    expect(deriveContentId('p', 'rectangle', 101, 100, 200, 100, 'Foo', '', '')).not.toBe(base);
    expect(deriveContentId('p', 'rectangle', 100, 100, 200, 100, 'Bar', '', '')).not.toBe(base);
    expect(deriveContentId('p', 'rectangle', 100, 100, 200, 100, 'Foo', 'a', '')).not.toBe(base);
    expect(deriveContentId('p', 'rectangle', 100, 100, 200, 100, 'Foo', '', 'b')).not.toBe(base);
  });

  it('rounds sub-pixel coords', () => {
    expect(
      deriveContentId('p', 'rectangle', 100.4, 100.4, 200, 100, '', '', '')
    ).toBe(
      deriveContentId('p', 'rectangle', 100.3, 100.4, 200, 100, '', '', '')
    );
  });
});

describe('POST /api/elements idempotency', () => {
  it('two identical creates → 1 row, same id', async () => {
    const payload = { type: 'rectangle', x: 100, y: 100, width: 200, height: 100, text: 'Foo' };
    const r1 = await request(app).post('/api/elements').send(payload);
    const r2 = await request(app).post('/api/elements').send(payload);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r1.body.element.id).toBe(r2.body.element.id);
    const all = getAllElements();
    expect(all.filter(e => e.id === r1.body.element.id)).toHaveLength(1);
  });

  it('explicit id short-circuits content hash', async () => {
    const r = await request(app)
      .post('/api/elements')
      .send({ id: 'custom-abc', type: 'ellipse', x: 0, y: 0, width: 50, height: 50 });
    expect(r.body.element.id).toBe('custom-abc');
  });

  it('position change → new id', async () => {
    const a = await request(app).post('/api/elements').send({ type: 'rectangle', x: 100, y: 100, width: 50, height: 50 });
    const b = await request(app).post('/api/elements').send({ type: 'rectangle', x: 101, y: 100, width: 50, height: 50 });
    expect(a.body.element.id).not.toBe(b.body.element.id);
    expect(getAllElements()).toHaveLength(2);
  });

  it('empty text element fingerprint stable', async () => {
    const payload = { type: 'rectangle', x: 50, y: 50, width: 30, height: 30 };
    await request(app).post('/api/elements').send(payload);
    await request(app).post('/api/elements').send(payload);
    expect(getAllElements()).toHaveLength(1);
  });

  it('same-position different-text → different ids', async () => {
    const r1 = await request(app).post('/api/elements').send({ type: 'rectangle', x: 100, y: 100, width: 50, height: 50, text: 'Foo' });
    const r2 = await request(app).post('/api/elements').send({ type: 'rectangle', x: 100, y: 100, width: 50, height: 50, text: 'Bar' });
    expect(r1.body.element.id).not.toBe(r2.body.element.id);
    expect(getAllElements()).toHaveLength(2);
  });

  it('cross-project (tenant) isolation: same content → different ids', async () => {
    ensureTenant('tenant-a', 'tenant-a', 'http:tenant-a');
    ensureTenant('tenant-b', 'tenant-b', 'http:tenant-b');
    const projA = getDefaultProjectForTenant('tenant-a');
    const projB = getDefaultProjectForTenant('tenant-b');
    expect(projA).not.toBe(projB);

    const payload = { type: 'rectangle', x: 100, y: 100, width: 50, height: 50, text: 'X' };
    const ra = await request(app).post('/api/elements').set('X-Tenant-Id', 'tenant-a').send(payload);
    const rb = await request(app).post('/api/elements').set('X-Tenant-Id', 'tenant-b').send(payload);
    expect(ra.body.element.id).not.toBe(rb.body.element.id);
  });
});

describe('POST /api/elements/batch idempotency', () => {
  it('two identical batches → N rows, not 2N', async () => {
    const elements = [
      { type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      { type: 'ellipse', x: 200, y: 200, width: 80, height: 80 },
      { type: 'rectangle', x: 400, y: 0, width: 60, height: 30, text: 'Hi' },
    ];
    await request(app).post('/api/elements/batch').send({ elements });
    await request(app).post('/api/elements/batch').send({ elements });
    expect(getAllElements()).toHaveLength(3);
  });

  it('bound arrows in batch get distinct ids (no collapse from placeholder coords)', async () => {
    // 3 boxes + 3 arrows binding A→B, A→C, B→C; arrows have no x,y/points
    // so server defaults coords. Without start/end refs in the fingerprint
    // the 3 arrows would collapse to 1 row.
    const elements = [
      { id: 'A', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      { id: 'B', type: 'rectangle', x: 300, y: 0, width: 100, height: 50 },
      { id: 'C', type: 'rectangle', x: 600, y: 0, width: 100, height: 50 },
      { type: 'arrow', x: 0, y: 0, start: { id: 'A' }, end: { id: 'B' } },
      { type: 'arrow', x: 0, y: 0, start: { id: 'A' }, end: { id: 'C' } },
      { type: 'arrow', x: 0, y: 0, start: { id: 'B' }, end: { id: 'C' } },
    ];
    const res = await request(app).post('/api/elements/batch').send({ elements });
    expect(res.status).toBe(200);
    const arrows = getAllElements().filter(e => e.type === 'arrow');
    expect(arrows).toHaveLength(3);
    const ids = new Set(arrows.map(a => a.id));
    expect(ids.size).toBe(3);
  });
});
