import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { ensureTenant as dbEnsureTenant } from '../db.js';
import { tenantContext, type TenantStore } from './tenant-context.js';

// Server-side default when X-Tenant-Id absent. Skill (Claude Code side) is
// expected to always set the header from caller's working-project context.
const DEFAULT_TENANT_NAME = 'default';

function deriveTenantId(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 12);
}

// Reads X-Tenant-Id (a human-readable name like "infra"), derives a stable
// 12-char id, ensures the tenant exists in SQLite, and runs the request
// handler inside the AsyncLocalStorage scope so tool dispatch sees this
// tenant.
export function tenantResolver(req: Request, res: Response, next: NextFunction): void {
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

  tenantContext.run(store, () => next());
}
