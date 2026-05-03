import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { initDb } from '../db.js';
import { createMcpServer } from '../index.js';
import { bearerAuth } from './auth.js';
import { tenantResolver } from './tenant-resolver.js';

// HTTP entrypoint for the Excalidraw MCP. Stateless mode: a fresh Server +
// Transport per request. State (elements, tenants) lives in SQLite and the
// canvas server (via EXPRESS_SERVER_URL), so per-request servers are cheap.
export async function startHttpServer(): Promise<void> {
  initDb();

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // POST /mcp — Streamable HTTP request/response. Auth + tenant scope wrap each call.
  app.post('/mcp', bearerAuth, tenantResolver, async (req: Request, res: Response) => {
    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        try { transport.close(); } catch { /* ignore */ }
        try { server.close(); } catch { /* ignore */ }
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('MCP request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'internal' });
      }
    }
  });

  // GET/DELETE not supported in stateless mode — explicit 405 for clarity.
  app.get('/mcp', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));
  app.delete('/mcp', (_req, res) => res.status(405).json({ error: 'Method Not Allowed' }));

  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`Excalidraw MCP HTTP server listening on :${port} (canvas: ${process.env.EXPRESS_SERVER_URL || 'unset'})`);
  });
}
