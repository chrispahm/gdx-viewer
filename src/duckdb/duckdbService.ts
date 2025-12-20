import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { AsyncDuckDB, AsyncDuckDBConnection, ConsoleLogger } from '@duckdb/duckdb-wasm';

export interface CancellationToken {
  isCancellationRequested: boolean;
}

export class CancellationError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancellationError';
  }
}

export interface GdxSymbol {
  name: string;
  type: string;
  dimensionCount: number;
  recordCount: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export class DuckdbService {
  private db: AsyncDuckDB | null = null;
  private conn: AsyncDuckDBConnection | null = null;
  private extensionPath: string;

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  async initialize(): Promise<void> {
    const duckdbRuntimeDir = path.join(this.extensionPath, 'dist', 'duckdb');
    const workerEntryPath = path.join(duckdbRuntimeDir, 'duckdb-worker-entry.cjs');
    const wasmPath = path.join(duckdbRuntimeDir, 'duckdb-eh.wasm');

    // Create Node.js worker_threads Worker using the wrapper that sets up Web Worker globals
    const nodeWorker = new Worker(workerEntryPath);

    // Create Web Worker compatible interface for duckdb-wasm's AsyncDuckDB
    const listeners = new Map<any, (event: { data: any }) => void>();
    const worker = {
      postMessage: (message: any, transfer?: any[]) => {
        nodeWorker.postMessage(message, transfer as any);
      },
      onmessage: null as ((event: { data: any }) => void) | null,
      onerror: null as ((error: Error) => void) | null,
      terminate: () => nodeWorker.terminate(),
      addEventListener: (type: string, listener: (event: { data: any }) => void) => {
        if (type === 'message') {
          const wrapped = (data: any) => listener({ data });
          listeners.set(listener, wrapped);
          nodeWorker.on('message', wrapped);
        }
      },
      removeEventListener: (type: string, listener: (event: { data: any }) => void) => {
        if (type === 'message') {
          const wrapped = listeners.get(listener);
          if (wrapped) {
            nodeWorker.off('message', wrapped);
            listeners.delete(listener);
          }
        }
      },
    };

    // Forward worker messages to onmessage handler
    nodeWorker.on('message', (data) => {
      if (worker.onmessage) {
        worker.onmessage({ data });
      }
    });

    nodeWorker.on('error', (err) => {
      console.error('[DuckDB] Worker error:', err);
      if (worker.onerror) {
        worker.onerror(err);
      }
    });

    this.db = new AsyncDuckDB(new ConsoleLogger(), worker as any);
    await this.db.instantiate(wasmPath);
    await this.db.open({ allowUnsignedExtensions: true });

    // Create a persistent connection for all queries
    this.conn = await this.db.connect();

    // Enable Excel export (requires excel extension)
    await this.conn.query('INSTALL excel');
    await this.conn.query('LOAD excel');

    // Load the GDX extension
    await this.conn.query(`INSTALL duckdb_gdx from 'https://humusklimanetz-couch.thuenen.de/datasets/duckdb_gdx_new'`);
    await this.conn.query(`LOAD duckdb_gdx`);

    // Warmup query to trigger any lazy initialization
    await this.conn.query('SELECT 1');
  }

  async registerGdxFile(uriString: string, bytes: Uint8Array): Promise<string> {
    if (!this.db) {
      throw new Error('DuckDB not initialized');
    }

    // Create unique registration name based on URI
    const hash = this.hashString(uriString);
    const registrationName = `gdx_${hash}.gdx`;

    await this.db.registerFileBuffer(registrationName, bytes);
    return registrationName;
  }

  async unregisterFile(registrationName: string): Promise<void> {
    if (!this.db) {
      return;
    }
    await this.db.dropFile(registrationName);
  }

  async getSymbols(registrationName: string): Promise<GdxSymbol[]> {
    if (!this.conn) {
      throw new Error('DuckDB not initialized');
    }

    const result = await this.conn.query(`
      SELECT symbol_name, symbol_type, dimension_count, record_count 
      FROM gdx_symbols('${registrationName}') 
      ORDER BY symbol_name
    `);

    return result.toArray().map((row: Record<string, unknown>) => ({
      name: row.symbol_name as string,
      type: row.symbol_type as string,
      dimensionCount: Number(row.dimension_count),
      recordCount: Number(row.record_count),
    }));
  }

  async getDomainValues(
    registrationName: string,
    symbol: string,
    dimIndex: number,
    token?: CancellationToken,
    dimensionFilters?: Map<string, string[]>
  ): Promise<string[]> {
    if (!this.conn) {
      throw new Error('DuckDB not initialized');
    }

    if (token?.isCancellationRequested) {
      throw new CancellationError();
    }

    // Build SQL with optional dimension filters
    let sql = `SELECT value FROM gdx_domain_values('${registrationName}', '${symbol}', ${dimIndex}`;

    if (dimensionFilters && dimensionFilters.size > 0) {
      // Build map expression: map(['dim_1', 'dim_2'], ['val1', 'val2'])
      const keys: string[] = [];
      const values: string[] = [];
      for (const [key, vals] of dimensionFilters.entries()) {
        // For now, take first value if multiple (single selection)
        if (vals.length > 0) {
          keys.push(key);
          values.push(vals[0].replace(/'/g, "''"));
        }
      }
      if (keys.length > 0) {
        sql += `, dimension_filters => map(['${keys.join("','")}'], ['${values.join("','")}'])`;
      }
    }

    sql += `)`;

    const result = await this.conn.query(sql);

    if (token?.isCancellationRequested) {
      throw new CancellationError();
    }

    return result.toArray().map((row: Record<string, unknown>) => row.value as string);
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    if (!this.conn) {
      throw new Error('DuckDB not initialized');
    }

    const result = await this.conn.query(sql);
    const rawRows = result.toArray() as Record<string, unknown>[];
    const columns = result.schema.fields.map(f => f.name);

    // Convert BigInt to Number for JSON serialization
    const rows = rawRows.map(row => {
      const converted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        converted[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      return converted;
    });

    return {
      columns,
      rows,
      rowCount: rows.length,
    };
  }

  async exportQuery(sql: string, format: 'csv' | 'parquet' | 'excel', destinationPath: string): Promise<void> {
    if (!this.conn) {
      throw new Error('DuckDB not initialized');
    }

    const normalizedFormat = format === 'excel' ? 'xlsx' : format;
    const escapedPath = destinationPath.replace(/'/g, "''");
    const copySql = `COPY (${sql}) TO '${escapedPath}' (FORMAT '${normalizedFormat}')`;
    await this.conn.query(copySql);
  }

  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  async dispose(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
    if (this.db) {
      await this.db.terminate();
      this.db = null;
    }
  }
}
