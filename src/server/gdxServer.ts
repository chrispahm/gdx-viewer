/**
 * GDX WebSocket Server
 * 
 * Runs DuckDB and GdxDocumentManager in a separate process from the VS Code extension host.
 * This bypasses any resource limitations in the extension host that may cause slowdowns.
 */

import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { DuckdbService, GdxSymbol } from '../duckdb/duckdbService';

interface ServerRequest {
  type: 'request';
  requestId: string;
  method: string;
  params: Record<string, unknown>;
}

interface ServerResponse {
  type: 'response';
  requestId: string;
  result?: unknown;
  error?: string;
}

interface DocumentState {
  source: string;
  registrationName: string;
  symbols: GdxSymbol[];
  duckdb: DuckdbService;
}

interface GdxServerOptions {
	allowRemoteSourceLoading: boolean;
}

export class GdxServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private documents = new Map<string, DocumentState>();
  private port: number = 0;
  private options: GdxServerOptions;
  // Request queue to serialize all DuckDB operations (prevents concurrent query issues)
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(options?: Partial<GdxServerOptions>) {
    this.options = {
      allowRemoteSourceLoading: false,
      ...options,
    };
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      ws.on('message', (data) => this.handleMessage(ws, data.toString()));
      ws.on('error', (err) => console.error('[GDX Server] WebSocket error:', err));
    });
  }

  async start(): Promise<number> {
    console.log('[GDX Server] Starting HTTP server...');

    // Start server on random available port
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        console.log(`[GDX Server] HTTP server listening on port ${this.port}`);
        resolve(this.port);
      });
    });
  }

  private async handleMessage(ws: WebSocket, data: string): Promise<void> {
    let request: ServerRequest;
    try {
      request = JSON.parse(data);
    } catch (e) {
      console.error('[GDX Server] Invalid JSON:', e);
      return;
    }

    const { requestId, method, params } = request;

    // Queue this request to ensure serial execution (serializes DuckDB operations for simplicity)
    this.requestQueue = this.requestQueue.then(async () => {
      try {
        const result = await this.handleRequest(method, params);
        this.sendResponse(ws, { type: 'response', requestId, result });
      } catch (error) {
        const fullMessage = error instanceof Error ? error.message : String(error);
        console.error(`[GDX Server] Error handling ${method}:`, fullMessage);

        // Fatal DuckDB error — reinitialize the affected document's instance and retry once
        if (isFatalDuckDbError(fullMessage)) {
          const documentId = params.documentId as string | undefined;
          const doc = documentId ? this.documents.get(documentId) : undefined;
          if (doc) {
            console.log(`[GDX Server] Fatal DuckDB error on ${documentId}, reinitializing...`);
            try {
              await doc.duckdb.reinitialize();
              const result = await this.handleRequest(method, params);
              this.sendResponse(ws, { type: 'response', requestId, result });
              return;
            } catch (retryError) {
              const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
              console.error(`[GDX Server] Retry after reinitialize also failed:`, retryMessage);
              this.sendResponse(ws, { type: 'response', requestId, error: sanitizeErrorMessage(retryMessage) });
              return;
            }
          }
        }

        this.sendResponse(ws, { type: 'response', requestId, error: sanitizeErrorMessage(fullMessage) });
      }
    });
  }

  private sendResponse(ws: WebSocket, response: ServerResponse): void {
    ws.send(JSON.stringify(response));
  }

  private async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'openDocument': {
        const source = (params.source as string | undefined) ?? (params.filePath as string | undefined);
        const documentId = params.documentId as string;
        const forceReload = Boolean(params.forceReload);
        if (!source) {
          throw new Error('Missing source path or URL');
        }

        const existing = this.documents.get(documentId);
        if (existing && !forceReload) {
          return { symbols: existing.symbols };
        }

        if (existing && forceReload) {
          // Dispose and recreate this document's DuckDB instance to clear native caches
          console.log(`[GDX Server] Force reload: reinitializing DuckDB for ${documentId}`);
          await existing.duckdb.reinitialize();
          const filePath = await this.resolveToLocalPath(source, existing.duckdb);
          const symbols = await existing.duckdb.getSymbols(filePath);
          existing.registrationName = filePath;
          existing.symbols = symbols;
          console.log(`[GDX Server] Document reloaded: ${documentId} (${source}) with ${symbols.length} symbols`);
          return { symbols };
        }

        // New document — create a dedicated DuckDB instance
        const duckdb = new DuckdbService();
        await duckdb.initialize();
        const filePath = await this.resolveToLocalPath(source, duckdb);
        const symbols = await duckdb.getSymbols(filePath);
        console.log(`[GDX Server] Document opened: ${documentId} (${source}) with ${symbols.length} symbols`);
        this.documents.set(documentId, { source, registrationName: filePath, symbols, duckdb });

        return { symbols };
      }

      case 'executeQuery': {
        const documentId = params.documentId as string;
        const sql = params.sql as string;

        const doc = this.documents.get(documentId);
        if (!doc) {
          throw new Error('Document not open');
        }

        // Replace placeholder with actual registration name
        const actualSql = this.rewriteSqlForDocument(sql, doc);
        const result = await doc.duckdb.executeQuery(actualSql);
        return result;
      }

      case 'getDomainValues': {
        const documentId = params.documentId as string;
        const symbol = params.symbol as string;
        const dimIndex = params.dimIndex as number;
        const dimensionFilters = params.dimensionFilters as Record<string, string[]> | undefined;

        const doc = this.documents.get(documentId);
        if (!doc) {
          throw new Error('Document not open');
        }

        const filtersMap = dimensionFilters
          ? new Map(Object.entries(dimensionFilters))
          : undefined;

        const values = await doc.duckdb.getDomainValues(
          doc.registrationName,
          symbol,
          dimIndex,
          undefined,
          filtersMap
        );
        return { values };
      }

      case 'closeDocument': {
        const documentId = params.documentId as string;
        const doc = this.documents.get(documentId);
        if (doc) {
          await doc.duckdb.dispose();
          this.documents.delete(documentId);
          console.log(`[GDX Server] Document closed: ${documentId}`);
        }
        return { success: true };
      }

      case 'ping': {
        return { pong: true };
      }

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private rewriteSqlForDocument(sql: string, doc: DocumentState): string {
    let rewrittenSql = sql.replace(/__GDX_FILE__/g, doc.registrationName);
    rewrittenSql = rewrittenSql.split(doc.source).join(doc.registrationName);
    return rewrittenSql;
  }

  private async resolveToLocalPath(source: string, duckdb: DuckdbService): Promise<string> {
    if (this.isHttpSource(source)) {
      if (!this.options.allowRemoteSourceLoading) {
        throw new Error('Remote source loading is disabled. Enable gdxViewer.allowRemoteSourceLoading to use HTTP/HTTPS sources.');
      }

      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Failed to fetch remote source (${response.status} ${response.statusText}): ${source}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      return duckdb.registerFile(source, bytes);
    }

    // Local file — DuckDB reads directly from disk
    return this.toLocalPath(source);
  }

  private isHttpSource(source: string): boolean {
    try {
      const uri = new URL(source);
      return uri.protocol === 'http:' || uri.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private toLocalPath(source: string): string {
    if (source.startsWith('file://')) {
      return fileURLToPath(source);
    }
    return source;
  }

  async stop(): Promise<void> {
    // Dispose each document's DuckDB instance
    for (const [, doc] of this.documents) {
      await doc.duckdb.dispose();
    }
    this.documents.clear();

    // Close server
    this.wss.close();
    this.server.close();
    console.log('[GDX Server] Stopped');
  }
}

function isFatalDuckDbError(message: string): boolean {
  return /database has been invalidated/i.test(message);
}

function sanitizeErrorMessage(message: string): string {
  // Replace fatal error with a friendly message
  if (/database has been invalidated/i.test(message)) {
    return 'The GDX file could not be read. It may have been modified or deleted externally. The viewer will attempt to recover automatically.';
  }

  // Strip C++ stack traces (everything after "Stack Trace:" or numbered frame lines)
  const stackTraceIdx = message.indexOf('Stack Trace:');
  if (stackTraceIdx !== -1) {
    message = message.substring(0, stackTraceIdx).trim();
  }
  // Remove numbered frame lines like "0  duckdb::..." or "1  0x..."
  message = message.replace(/\n\d+\s+(duckdb::|0x)[^\n]*/g, '').trim();

  // Truncate very long messages
  const MAX_LENGTH = 500;
  if (message.length > MAX_LENGTH) {
    message = message.substring(0, MAX_LENGTH) + '...';
  }

  return message;
}
