import type { Request, Response, NextFunction } from 'express';

// Bearer token auth. Single shared MCP_AUTH_TOKEN — single trust domain.
// Tenants are scoping (per-request via X-Tenant-Id), not security boundaries.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) {
    console.error('MCP_AUTH_TOKEN not set — rejecting all requests');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ') || header.slice(7) !== AUTH_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}
