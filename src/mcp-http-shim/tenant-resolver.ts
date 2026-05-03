import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import fetch from 'node-fetch';
import { ensureTenant as dbEnsureTenant } from '../db.js';
import { tenantContext, type TenantStore } from './tenant-context.js';

// Server-side default when X-Tenant-Id absent. Skill (Claude Code side) is
// expected to always set the header from caller's working-project context.
const DEFAULT_TENANT_NAME = 'default';
const CANVAS_URL = process.env.EXPRESS_SERVER_URL || 'http://localhost:3000';

function deriveTenantId(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 12);
}

// Per-process cache of tenants we've already ensured on canvas. Avoids hitting
// canvas POST /api/tenants on every MCP request once the tenant is registered.
const ensuredOnCanvas = new Set<string>();

async function ensureTenantOnCanvas(tenantId: string, name: string): Promise<void> {
  if (ensuredOnCanvas.has(tenantId)) return;
  try {
    const res = await fetch(`${CANVAS_URL}/api/tenants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': tenantId },
      body: JSON.stringify({ id: tenantId, name, workspacePath: `http:${name}` }),
    });
    if (res.ok) ensuredOnCanvas.add(tenantId);
    else console.error(`canvas tenant ensure failed: HTTP ${res.status}`);
  } catch (e) {
    console.error('canvas tenant ensure error:', (e as Error).message);
  }
}

// Reads X-Tenant-Id (a human-readable name like "infra"), derives a stable
// 12-char id, ensures the tenant exists in BOTH the MCP-local DB and the
// canvas DB (cross-pod), and runs the request handler inside the
// AsyncLocalStorage scope so tool dispatch sees this tenant.
//
// Awaits the canvas ensure on first observation per tenant — element inserts
// would otherwise race the FK constraint. Subsequent requests skip via cache
// (~50ms one-time cost per new tenant per pod lifetime).
export async function tenantResolver(req: Request, res: Response, next: NextFunction): Promise<void> {
  const headerName = (req.headers['x-tenant-id'] as string | undefined)?.trim() || DEFAULT_TENANT_NAME;
  const tenantId = deriveTenantId(headerName);
  const store: TenantStore = { tenantId, tenantName: headerName };

  try {
    dbEnsureTenant(tenantId, headerName, `http:${headerName}`);
  } catch (e) {
    console.error('tenantResolver ensureTenant failed:', (e as Error).message);
    res.status(500).json({ error: 'tenant init failed' });
    return;
  }

  await ensureTenantOnCanvas(tenantId, headerName);
  tenantContext.run(store, () => next());
}
