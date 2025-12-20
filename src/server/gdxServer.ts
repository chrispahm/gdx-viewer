/**
 * GDX WebSocket Server
 * 
 * Runs DuckDB and GdxDocumentManager in a separate process from the VS Code extension host.
 * This bypasses any resource limitations in the extension host that may cause slowdowns.
 */

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { DuckdbService, GdxSymbol, QueryResult } from '../duckdb/duckdbService';

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
  filePath: string;
  registrationName: string;
  symbols: GdxSymbol[];
}

export class GdxServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private duckdbService: DuckdbService;
  private documents = new Map<string, DocumentState>();
  private port: number = 0;
  // Request queue to serialize all DuckDB operations (prevents concurrent query issues)
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(extensionPath: string) {
    this.duckdbService = new DuckdbService(extensionPath);
    this.server = http.createServer();
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      ws.on('message', (data) => this.handleMessage(ws, data.toString()));
      ws.on('error', (err) => console.error('[GDX Server] WebSocket error:', err));
    });
  }

  async start(): Promise<number> {
    // Initialize DuckDB
    await this.duckdbService.initialize();

    // Start server on random available port
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
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

    // Queue this request to ensure serial execution (DuckDB WASM can't handle concurrent queries)
    this.requestQueue = this.requestQueue.then(async () => {
      try {
        const result = await this.handleRequest(method, params);
        this.sendResponse(ws, { type: 'response', requestId, result });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[GDX Server] Error handling ${method}:`, errorMessage);
        this.sendResponse(ws, { type: 'response', requestId, error: errorMessage });
      }
    });
  }

  private sendResponse(ws: WebSocket, response: ServerResponse): void {
    ws.send(JSON.stringify(response));
  }

  private async handleRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'openDocument': {
        const filePath = params.filePath as string;
        const documentId = params.documentId as string;

        // Check if already open
        if (this.documents.has(documentId)) {
          const doc = this.documents.get(documentId)!;
          return { symbols: doc.symbols };
        }

        // Read file and register with DuckDB
        const bytes = await fs.readFile(filePath);
        const registrationName = await this.duckdbService.registerGdxFile(filePath, new Uint8Array(bytes));
        const symbols = await this.duckdbService.getSymbols(registrationName);

        this.documents.set(documentId, { filePath, registrationName, symbols });

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
        const actualSql = sql.replace(/__GDX_FILE__/g, doc.registrationName);
        const result = await this.duckdbService.executeQuery(actualSql);
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

        const values = await this.duckdbService.getDomainValues(
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
          await this.duckdbService.unregisterFile(doc.registrationName);
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

  async stop(): Promise<void> {
    // Close all documents
    for (const [id, doc] of this.documents) {
      await this.duckdbService.unregisterFile(doc.registrationName);
    }
    this.documents.clear();

    // Dispose DuckDB
    await this.duckdbService.dispose();

    // Close server
    this.wss.close();
    this.server.close();
    console.log('[GDX Server] Stopped');
  }
}
