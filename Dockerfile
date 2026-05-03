# Dockerfile for MCP Excalidraw Server
# Builds the MCP server with SQLite persistence

# Stage 1: Build backend (TypeScript compilation + native modules)
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY src ./src
COPY tsconfig.json ./
RUN npm run build:server

# Stage 2: Production MCP Server
FROM node:20-slim AS production

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --gid 1001 nodejs

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Remove build tools after native modules are compiled
RUN apt-get purge -y python3 make g++ && apt-get autoremove -y

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data && chown -R nodejs:nodejs /app
USER nodejs

ENV NODE_ENV=production
ENV EXPRESS_SERVER_URL=http://localhost:3000
ENV ENABLE_CANVAS_SYNC=true
ENV EXCALIDRAW_DB_PATH=/app/data/excalidraw.db
# MCP_TRANSPORT=http selects the Streamable HTTP shim (mcp-http-shim/server.ts);
# leave unset (or =stdio) to keep upstream stdio behavior for local dev.
# When http: also set MCP_AUTH_TOKEN, EXPRESS_SERVER_URL, PORT.
ENV MCP_TRANSPORT=http
EXPOSE 3000

CMD ["node", "dist/index.js"]

LABEL org.opencontainers.image.source="https://github.com/dataplanelabs/excalidraw"
LABEL org.opencontainers.image.vendor="DataPlaneLabs"
LABEL org.opencontainers.image.description="DataPlaneLabs Excalidraw MCP Server (HTTP transport, SQLite persistence, multi-tenancy)"
LABEL org.opencontainers.image.licenses="MIT"
