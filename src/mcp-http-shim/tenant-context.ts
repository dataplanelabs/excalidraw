import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request tenant scope. When the HTTP transport is active, every request
// runs inside a tenantContext.run() so that downstream code (canvasHeaders in
// index.ts) can read the tenant for THIS request rather than a shared global.
// In stdio mode, the store is undefined and callers fall back to the
// process-wide active tenant (legacy behavior).
export interface TenantStore {
  tenantId: string;
  tenantName: string;
}

export const tenantContext = new AsyncLocalStorage<TenantStore>();
