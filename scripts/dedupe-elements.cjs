#!/usr/bin/env node
/**
 * One-time cleanup of duplicate elements caused by retried batch_create_elements.
 *
 * Mirrors the server-side fingerprint in src/server.ts (deriveContentId).
 * Groups by fingerprint, keeps the lowest sync_version (the original),
 * soft-deletes the rest, bumps project sync_version per survivor so connected
 * browsers reconcile via delta sync.
 *
 * Usage:
 *   node scripts/dedupe-elements.cjs                       # dry-run, all projects
 *   node scripts/dedupe-elements.cjs --execute             # apply
 *   node scripts/dedupe-elements.cjs --project foo         # restrict
 *   node scripts/dedupe-elements.cjs --db /path/excalidraw.db
 */

const path = require('node:path');
const crypto = require('node:crypto');

function fingerprint(projectId, type, x, y, w, h, text, startRefId, endRefId) {
  const input = [
    projectId,
    type,
    Math.round(x || 0),
    Math.round(y || 0),
    Math.round(w || 0),
    Math.round(h || 0),
    text || '',
    startRefId || '',
    endRefId || ''
  ].join('|');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function elementText(el) {
  if (el && el.label && el.label.text) return String(el.label.text);
  if (el && typeof el.text === 'string') return el.text;
  return '';
}

function elementStartRef(el) { return (el && el.start && el.start.id) || ''; }
function elementEndRef(el) { return (el && el.end && el.end.id) || ''; }

// Pure: returns { groups, totalDups }
// groups :: { [fp]: [{id, sync_version, data}, ...] }
function bucketByFingerprint(rows, projectId) {
  const groups = {};
  for (const row of rows) {
    let data;
    try { data = JSON.parse(row.data); } catch { continue; }
    const fp = fingerprint(
      projectId,
      data.type || row.type,
      data.x, data.y, data.width, data.height,
      elementText(data),
      elementStartRef(data),
      elementEndRef(data)
    );
    (groups[fp] = groups[fp] || []).push(row);
  }
  let dups = 0;
  for (const fp of Object.keys(groups)) if (groups[fp].length > 1) dups += groups[fp].length - 1;
  return { groups, totalDups: dups };
}

function dedupeProject(db, projectId, execute) {
  const rows = db.prepare(
    'SELECT id, type, data, sync_version FROM elements WHERE project_id = ? AND is_deleted = 0'
  ).all(projectId);
  const { groups, totalDups } = bucketByFingerprint(rows, projectId);
  const dupGroups = Object.values(groups).filter(g => g.length > 1);

  const plan = [];
  for (const group of dupGroups) {
    // Keep lowest sync_version (original)
    const sorted = group.slice().sort((a, b) => a.sync_version - b.sync_version);
    const keep = sorted[0];
    const drop = sorted.slice(1);
    plan.push({ keepId: keep.id, dropIds: drop.map(r => r.id) });
  }

  if (execute && plan.length > 0) {
    const txn = db.transaction(() => {
      const now = new Date().toISOString();
      for (const { keepId, dropIds } of plan) {
        // Bump global project sync_version once per survivor and stamp it on
        // both the survivor and the soft-deleted dups so getChangesSince emits
        // both events to clients (delete dups, upsert survivor).
        db.prepare('UPDATE projects SET sync_version = sync_version + 1 WHERE id = ?').run(projectId);
        const newSv = db.prepare('SELECT sync_version FROM projects WHERE id = ?').get(projectId).sync_version;
        for (const id of dropIds) {
          db.prepare(
            'UPDATE elements SET is_deleted = 1, sync_version = ?, updated_at = ? WHERE id = ?'
          ).run(newSv, now, id);
        }
        db.prepare(
          'UPDATE elements SET sync_version = ?, updated_at = ? WHERE id = ?'
        ).run(newSv, now, keepId);
      }
    });
    txn();
  }

  return {
    projectId,
    total: rows.length,
    dupGroups: dupGroups.length,
    softDeleted: plan.reduce((acc, p) => acc + p.dropIds.length, 0),
    plan
  };
}

function parseArgs(argv) {
  const args = { execute: false, db: null, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') args.execute = true;
    else if (a === '--db') args.db = argv[++i];
    else if (a === '--project') args.project = argv[++i];
  }
  return args;
}

function main() {
  const Database = require('better-sqlite3');
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db || process.env.EXCALIDRAW_DB_PATH || path.resolve(process.cwd(), 'data/excalidraw.db');
  const db = new Database(dbPath);

  const projects = args.project
    ? db.prepare('SELECT id, name FROM projects WHERE id = ?').all(args.project)
    : db.prepare('SELECT id, name FROM projects ORDER BY id').all();

  if (projects.length === 0) {
    console.log(`No matching project. db=${dbPath}`);
    process.exit(1);
  }

  console.log(`db: ${dbPath}`);
  console.log(`mode: ${args.execute ? 'EXECUTE (will mutate)' : 'dry-run (no changes)'}`);
  console.log('');

  let totalSoftDeleted = 0;
  for (const p of projects) {
    const res = dedupeProject(db, p.id, args.execute);
    console.log(`[${p.id}] "${p.name}": active=${res.total}, dup-groups=${res.dupGroups}, would-soft-delete=${res.softDeleted}`);
    if (res.plan.length > 0 && !args.execute) {
      for (const { keepId, dropIds } of res.plan.slice(0, 5)) {
        console.log(`  keep ${keepId} drop ${dropIds.join(',')}`);
      }
      if (res.plan.length > 5) console.log(`  ... +${res.plan.length - 5} more groups`);
    }
    totalSoftDeleted += res.softDeleted;
  }

  console.log('');
  console.log(`TOTAL: ${args.execute ? 'soft-deleted' : 'would soft-delete'} ${totalSoftDeleted} rows across ${projects.length} project(s)`);
  if (!args.execute && totalSoftDeleted > 0) {
    console.log('Re-run with --execute to apply.');
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e); process.exit(1); }
}

module.exports = { fingerprint, bucketByFingerprint, dedupeProject };
