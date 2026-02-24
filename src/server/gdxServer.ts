/**
 * GDX WebSocket Server
 *
 * Runs DuckDB in a separate process from the VS Code extension host.
 * This bypasses any resource limitations in the extension host that may cause slowdowns.
 *
 * Uses a single shared persistent DuckDB database. Each opened symbol is materialized
 * into a DuckDB table for fast pagination, filtering, and cross-filtering.
 */

import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { DuckDBConnection } from '@duckdb/node-api';
import { DuckdbService, GdxSymbol } from '../duckdb/duckdbService';
import { ColumnFilter, FilterValue, NumericFilterState } from './filterTypes';

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

interface MaterializedSymbol {
  tableName: string;      // unquoted, e.g. "docId__symbolName"
  columns: string[];
  totalRowCount: number;
}

interface DocumentState {
  source: string;
  localPath: string;
  symbols: GdxSymbol[];
  materializedSymbols: Map<string, MaterializedSymbol>;
}

interface ActiveMaterialization {
  connection: DuckDBConnection;
  cancelled: boolean;
  progressInterval: ReturnType<typeof setInterval> | null;
  promise: Promise<void>;
}

interface GdxServerOptions {
  allowRemoteSourceLoading: boolean;
  globalStoragePath?: string;
}

export class GdxServer {
  private server: http.Server;
  private wss: WebSocketServer;
  private documents = new Map<string, DocumentState>();
  private port: number = 0;
  private options: GdxServerOptions;
  // Request queue to serialize all DuckDB operations (prevents concurrent query issues)
  private requestQueue: Promise<void> = Promise.resolve();
  // Single shared DuckDB instance
  private duckdb: DuckdbService | null = null;
  private dbFilePath: string | null = null;
  // Track WebSocket per document for pushing events
  private documentWebSockets = new Map<string, WebSocket>();
  // Track active background materializations (keyed by documentId)
  private activeMaterializations = new Map<string, ActiveMaterialization>();

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

    // Initialize shared DuckDB instance
    await this.initializeDuckDb();

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

  private async initializeDuckDb(): Promise<void> {
    const uuid = crypto.randomUUID();
    if (this.options.globalStoragePath) {
      this.dbFilePath = path.join(this.options.globalStoragePath, `gdx-viewer-${uuid}.duckdb`);
    } else {
      this.dbFilePath = null;
    }

    this.duckdb = new DuckdbService();
    await this.duckdb.initialize(this.dbFilePath ?? undefined);
    console.log(`[GDX Server] DuckDB initialized (${this.dbFilePath ?? ':memory:'})`);
  }

  private async teardownDuckDb(): Promise<void> {
    // Cancel all active materializations first
    const cancelPromises = [...this.activeMaterializations.keys()].map(docId =>
      this.cancelMaterialization(docId)
    );
    await Promise.allSettled(cancelPromises);

    if (this.duckdb) {
      await this.duckdb.dispose();
      this.duckdb = null;
    }

    // Delete the persistent DB file and WAL
    if (this.dbFilePath) {
      for (const suffix of ['', '.wal']) {
        try {
          await fs.unlink(this.dbFilePath + suffix);
        } catch {
          // File may not exist
        }
      }
      this.dbFilePath = null;
    }
  }

  private makeTableName(documentId: string, symbolName: string): string {
    // Sanitize: replace characters that are problematic in identifiers
    const safeDocId = documentId.replace(/[^a-zA-Z0-9_]/g, '_');
    const safeSym = symbolName.replace(/"/g, '""');
    return `${safeDocId}__${safeSym}`;
  }

  private quotedTableName(documentId: string, symbolName: string): string {
    return `"${this.makeTableName(documentId, symbolName)}"`;
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

    // Track WebSocket per document for server-push events
    const documentId = params?.documentId as string | undefined;
    if (documentId) {
      this.documentWebSockets.set(documentId, ws);
    }

    // Queue this request to ensure serial execution (serializes DuckDB operations for simplicity)
    this.requestQueue = this.requestQueue.then(async () => {
      try {
        const result = await this.handleRequest(method, params);
        this.sendResponse(ws, { type: 'response', requestId, result });
      } catch (error) {
        const fullMessage = error instanceof Error ? error.message : String(error);
        console.error(`[GDX Server] Error handling ${method}:`, fullMessage);

        // Fatal DuckDB error — full teardown/reinitialize and retry once
        if (isFatalDuckDbError(fullMessage)) {
          console.log(`[GDX Server] Fatal DuckDB error, reinitializing...`);
          try {
            // Clear all materialized symbols since tables are lost
            for (const doc of this.documents.values()) {
              doc.materializedSymbols.clear();
            }
            await this.teardownDuckDb();
            await this.initializeDuckDb();
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

        this.sendResponse(ws, { type: 'response', requestId, error: sanitizeErrorMessage(fullMessage) });
      }
    });
  }

  private sendResponse(ws: WebSocket, response: ServerResponse): void {
    ws.send(JSON.stringify(response));
  }

  private sendEvent(ws: WebSocket, event: string, data: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'event', event, data }));
    }
  }

  private async cancelMaterialization(documentId: string): Promise<void> {
    const active = this.activeMaterializations.get(documentId);
    if (!active) return;

    active.cancelled = true;
    try {
      active.connection.interrupt();
    } catch {
      // Connection may already be closed
    }

    // Wait for the background promise to settle
    try {
      await active.promise;
    } catch {
      // Expected — interrupted queries throw
    }
  }

  private startBackgroundMaterialization(
    ws: WebSocket,
    documentId: string,
    symbolName: string,
    doc: DocumentState,
    recordCount: number,
  ): void {
    const tableName = this.makeTableName(documentId, symbolName);
    const quotedTable = `"${tableName}"`;
    const escapedPath = doc.localPath.replace(/'/g, "''");
    const escapedSymbol = symbolName.replace(/'/g, "''");

    // Create the active entry before starting work to avoid race with cancelMaterialization
    const active: ActiveMaterialization = {
      connection: null as unknown as DuckDBConnection,
      cancelled: false,
      progressInterval: null,
      promise: null as unknown as Promise<void>,
    };
    this.activeMaterializations.set(documentId, active);

    const doWork = async () => {
      let bgConn: DuckDBConnection | null = null;

      try {
        if (active.cancelled) { return; }

        bgConn = await this.duckdb!.createBackgroundConnection();
        active.connection = bgConn;
        await this.duckdb!.runOnConnection(bgConn, 'LOAD gdx');

        if (active.cancelled) { return; }

        // Poll progress every 500ms
        active.progressInterval = setInterval(() => {
          if (active.cancelled) { return; }
          try {
            const progress = bgConn!.progress;
            const rowsProcessed = Number(progress.rows_processed);

            // Compute percentage ourselves from recordCount (DuckDB doesn't know total for external table functions)
            let percentage: number;
            if (rowsProcessed > 0 && recordCount > 0) {
              percentage = Math.min((rowsProcessed / recordCount) * 100, 100);
            } else if (progress.percentage > 0) {
              percentage = progress.percentage;
            } else {
              percentage = 0;
            }

            this.sendEvent(ws, 'materializationProgress', {
              documentId,
              symbolName,
              percentage,
              rowsProcessed,
              totalRows: recordCount,
            });
          } catch {
            // Connection may be closing
          }
        }, 500);

        // Run the full CREATE TABLE
        await this.duckdb!.runOnConnection(
          bgConn,
          `CREATE OR REPLACE TABLE ${quotedTable} AS SELECT * FROM read_gdx('${escapedPath}', '${escapedSymbol}')`
        );

        if (active.cancelled) { return; }

        // Clear progress polling before querying
        if (active.progressInterval) {
          clearInterval(active.progressInterval);
          active.progressInterval = null;
        }

        // Get columns + count on the background connection (avoids queue contention)
        const colResult = await this.duckdb!.executeQueryOnConnection(
          bgConn,
          `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableName.replace(/'/g, "''")}' ORDER BY ordinal_position`
        );
        const columns = colResult.rows.map(row => row.column_name as string);

        const countResult = await this.duckdb!.executeQueryOnConnection(
          bgConn,
          `SELECT COUNT(*) as cnt FROM ${quotedTable}`
        );
        const totalRowCount = Number(countResult.rows[0].cnt);

        if (active.cancelled) { return; }

        // Cache the materialized result
        const materialized: MaterializedSymbol = { tableName, columns, totalRowCount };
        doc.materializedSymbols.set(symbolName, materialized);
        console.log(`[GDX Server] Background materialized ${documentId}/${symbolName}: ${totalRowCount} rows`);

        this.sendEvent(ws, 'materializationComplete', {
          documentId,
          symbolName,
          tableName,
          columns,
          totalRowCount,
        });
      } catch (err) {
        const cancelled = active.cancelled;

        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[GDX Server] Background materialization error for ${documentId}/${symbolName}:`, message);
          this.sendEvent(ws, 'materializationError', {
            documentId,
            symbolName,
            cancelled: false,
            error: sanitizeErrorMessage(message),
          });
        } else {
          this.sendEvent(ws, 'materializationError', {
            documentId,
            symbolName,
            cancelled: true,
          });
        }
      } finally {
        if (active.progressInterval) clearInterval(active.progressInterval);
        if (bgConn) {
          try { bgConn.disconnectSync(); } catch { /* ignore */ }
        }
        this.activeMaterializations.delete(documentId);
      }
    };

    active.promise = doWork();
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
          // Cancel any active materialization before force reload
          await this.cancelMaterialization(documentId);

          // Drop all materialized tables for this document
          await this.dropMaterializedTables(documentId, existing);

          // Full teardown and reinitialize to clear native GDX caches
          console.log(`[GDX Server] Force reload: full DuckDB teardown/reinitialize`);
          // Clear ALL materialized symbols for every document (DB is being recreated)
          for (const doc of this.documents.values()) {
            doc.materializedSymbols.clear();
          }
          await this.teardownDuckDb();
          await this.initializeDuckDb();

          // Re-read symbols for all open documents
          for (const [docId, doc] of this.documents) {
            const filePath = await this.resolveToLocalPath(doc.source);
            doc.localPath = filePath;
            doc.symbols = await this.duckdb!.getSymbols(filePath);
            console.log(`[GDX Server] Re-read symbols for ${docId}: ${doc.symbols.length} symbols`);
          }

          return { symbols: existing.symbols };
        }

        // New document — resolve path, get symbols (no materialization yet)
        const filePath = await this.resolveToLocalPath(source);
        const symbols = await this.duckdb!.getSymbols(filePath);
        console.log(`[GDX Server] Document opened: ${documentId} (${source}) with ${symbols.length} symbols`);
        this.documents.set(documentId, {
          source,
          localPath: filePath,
          symbols,
          materializedSymbols: new Map(),
        });

        return { symbols };
      }

      case 'materializeSymbol': {
        const documentId = params.documentId as string;
        const symbolName = params.symbolName as string;
        const pageSize = (params.pageSize as number | undefined) ?? 1000;

        const doc = this.documents.get(documentId);
        if (!doc) {
          throw new Error('Document not open');
        }

        // Return cached info if already materialized
        const cached = doc.materializedSymbols.get(symbolName);
        if (cached) {
          return { ...cached, status: 'materialized' };
        }

        // Cancel any running materialization for this document (symbol switch)
        await this.cancelMaterialization(documentId);

        const escapedPath = doc.localPath.replace(/'/g, "''");
        const escapedSymbol = symbolName.replace(/'/g, "''");

        // Phase 1: Fast preview query with LIMIT
        const previewResult = await this.duckdb!.executeQuery(
          `SELECT * FROM read_gdx('${escapedPath}', '${escapedSymbol}') LIMIT ${pageSize}`
        );

        // Use symbol.recordCount as estimated total
        const symbolInfo = doc.symbols.find(s => s.name === symbolName);
        const estimatedTotal = symbolInfo?.recordCount ?? previewResult.rowCount;

        // Phase 2: Start background materialization (fire-and-forget)
        const ws = this.documentWebSockets.get(documentId);
        if (ws) {
          this.startBackgroundMaterialization(ws, documentId, symbolName, doc, symbolInfo?.recordCount ?? 0);
        }

        return {
          tableName: null,
          columns: previewResult.columns,
          totalRowCount: estimatedTotal,
          status: 'preview',
          previewRows: previewResult.rows,
          previewRowCount: previewResult.rowCount,
        };
      }

      case 'cancelMaterialization': {
        const documentId = params.documentId as string;
        await this.cancelMaterialization(documentId);
        return { success: true };
      }

      case 'getFilterOptions': {
        const documentId = params.documentId as string;
        const symbolName = params.symbolName as string;
        const currentFilters = (params.filters ?? []) as ColumnFilter[];

        const doc = this.documents.get(documentId);
        if (!doc) {
          throw new Error('Document not open');
        }

        const materialized = doc.materializedSymbols.get(symbolName);
        if (!materialized) {
          throw new Error(`Symbol '${symbolName}' is not materialized`);
        }

        const quotedTable = `"${materialized.tableName}"`;
        const filterOptions: Record<string, string[]> = {};

        // For each text column (dim_*), get distinct values with cross-filtering
        const dimColumns = materialized.columns.filter(col => col.startsWith('dim_'));
        for (const col of dimColumns) {
          // Build WHERE clause excluding filters on THIS column (cross-filtering)
          const otherFilters = currentFilters.filter(f => f.columnName !== col);
          const whereClause = buildWhereClause(otherFilters);
          const sql = `SELECT DISTINCT "${col}" FROM ${quotedTable}${whereClause} ORDER BY "${col}"`;
          const result = await this.duckdb!.executeQuery(sql);
          filterOptions[col] = result.rows.map(row => row[col] as string);
        }

        return { filterOptions };
      }

      case 'executeQuery': {
        const documentId = params.documentId as string;
        const sql = params.sql as string;

        const doc = this.documents.get(documentId);
        if (!doc) {
          throw new Error('Document not open');
        }

        // Rewrite __GDX_FILE__ placeholder for backward compat (custom SQL, LM tools)
        const actualSql = this.rewriteSqlForDocument(sql, doc);
        const result = await this.duckdb!.executeQuery(actualSql);
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

        // If symbol is materialized, query the table directly (faster)
        const materialized = doc.materializedSymbols.get(symbol);
        if (materialized) {
          const colName = `dim_${dimIndex}`;
          if (!materialized.columns.includes(colName)) {
            return { values: [] };
          }
          const quotedTable = `"${materialized.tableName}"`;
          const result = await this.duckdb!.executeQuery(
            `SELECT DISTINCT "${colName}" FROM ${quotedTable} ORDER BY "${colName}"`
          );
          const values = result.rows.map(row => row[colName] as string);
          return { values };
        }

        // Fall back to gdx_domain_values() for non-materialized symbols (LM tool path)
        const filtersMap = dimensionFilters
          ? new Map(Object.entries(dimensionFilters))
          : undefined;

        const values = await this.duckdb!.getDomainValues(
          doc.localPath,
          symbol,
          dimIndex,
          undefined,
          filtersMap
        );
        return { values };
      }

      case 'closeDocument': {
        const documentId = params.documentId as string;

        // Cancel any active materialization for this document
        await this.cancelMaterialization(documentId);
        this.documentWebSockets.delete(documentId);

        const doc = this.documents.get(documentId);
        if (doc) {
          // Drop all materialized tables for this document
          await this.dropMaterializedTables(documentId, doc);

          // Checkpoint to reclaim disk space
          try {
            await this.duckdb!.executeQuery('CHECKPOINT');
          } catch {
            // Non-critical
          }

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

  private async dropMaterializedTables(documentId: string, doc: DocumentState): Promise<void> {
    for (const [symbolName] of doc.materializedSymbols) {
      const quotedTable = this.quotedTableName(documentId, symbolName);
      try {
        await this.duckdb!.executeQuery(`DROP TABLE IF EXISTS ${quotedTable}`);
      } catch (err) {
        console.warn(`[GDX Server] Failed to drop table ${quotedTable}:`, err);
      }
    }
    doc.materializedSymbols.clear();
  }

  private rewriteSqlForDocument(sql: string, doc: DocumentState): string {
    let rewrittenSql = sql.replace(/__GDX_FILE__/g, doc.localPath);
    rewrittenSql = rewrittenSql.split(doc.source).join(doc.localPath);
    return rewrittenSql;
  }

  private async resolveToLocalPath(source: string): Promise<string> {
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
      return this.duckdb!.registerFile(source, bytes);
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
    this.documents.clear();
    this.documentWebSockets.clear();
    await this.teardownDuckDb();

    // Close server
    this.wss.close();
    this.server.close();
    console.log('[GDX Server] Stopped');
  }
}

// --- Filter types and WHERE clause builder ---

function isNumericFilter(filter: FilterValue): filter is NumericFilterState {
  return 'exclude' in filter;
}

function buildWhereClause(filters: ColumnFilter[]): string {
  const clauses: string[] = [];

  for (const filter of filters) {
    const { columnName, filterValue } = filter;

    if (isNumericFilter(filterValue)) {
      const conditions: string[] = [];

      const hasDisabledSpecialValues =
        !filterValue.showEPS ||
        !filterValue.showNA ||
        !filterValue.showPosInf ||
        !filterValue.showNegInf ||
        !filterValue.showUNDF;

      if (!hasDisabledSpecialValues && filterValue.min === undefined && filterValue.max === undefined) {
        continue;
      }

      const excludedSpecialValues: string[] = [];
      if (!filterValue.showEPS) { excludedSpecialValues.push('EPS'); }
      if (!filterValue.showNA) { excludedSpecialValues.push('NA'); }
      if (!filterValue.showUNDF) { excludedSpecialValues.push('UNDF'); }

      if (!filterValue.showPosInf) {
        excludedSpecialValues.push('+INF');
        conditions.push(`"${columnName}" != CAST('Infinity' AS DOUBLE)`);
      }
      if (!filterValue.showNegInf) {
        excludedSpecialValues.push('-INF');
        conditions.push(`"${columnName}" != CAST('-Infinity' AS DOUBLE)`);
      }

      if (excludedSpecialValues.length > 0) {
        const excludeList = excludedSpecialValues.map(v => `'${v}'`).join(', ');
        conditions.push(`CAST("${columnName}" AS VARCHAR) NOT IN (${excludeList})`);
      }

      if (filterValue.min !== undefined) {
        conditions.push(`"${columnName}" >= ${filterValue.min}`);
      }
      if (filterValue.max !== undefined) {
        conditions.push(`"${columnName}" <= ${filterValue.max}`);
      }

      if (conditions.length > 0) {
        let clause = conditions.join(' AND ');
        if (filterValue.exclude) {
          clause = `NOT (${clause})`;
        }
        clauses.push(`(${clause})`);
      }
    } else {
      // Text filter
      if (filterValue.selectedValues.length === 0) {
        continue;
      }
      const valueList = filterValue.selectedValues.map((v: string) => `'${v.replace(/'/g, "''")}'`).join(', ');
      clauses.push(`"${columnName}" IN (${valueList})`);
    }
  }

  if (clauses.length === 0) {
    return '';
  }
  return ` WHERE ${clauses.join(' AND ')}`;
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
