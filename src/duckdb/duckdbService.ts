import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
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
  private server: http.Server | null = null;
  private port: number = 0;
  private extensionPath: string;

  constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  async initialize(): Promise<void> {
    // Initialize DuckDB-WASM with native worker_threads (polyfilled to Web Worker API)
    const duckdbRuntimeDir = path.join(this.extensionPath, 'dist', 'duckdb');
    const workerPath = path.join(duckdbRuntimeDir, 'duckdb-node-eh.bundled.worker.cjs');
    const wasmPath = path.join(duckdbRuntimeDir, 'duckdb-eh.wasm');

    // Write a small wrapper to polyfill the Web Worker API expected by duckdb-wasm
    const wrapperContent = `
const { parentPort } = require('worker_threads');
global.self = global;
global.postMessage = (msg) => parentPort.postMessage(msg);

global.addEventListener = (type, handler) => {
  if (type === 'message') {
    parentPort.on('message', (msg) => handler({ data: msg }));
  }
};

Object.defineProperty(global, 'onmessage', {
  set: (handler) => {
    parentPort.on('message', (msg) => handler && handler({ data: msg }));
  },
  get: () => null,
});

require('${workerPath.replace(/\\/g, '\\\\')}');
`;

    const wrapperPath = path.join(this.extensionPath, 'dist', 'duckdb-worker-wrapper.js');
    await fs.writeFile(wrapperPath, wrapperContent);

    const nodeWorker = new Worker(wrapperPath, { execArgv: [] });

    // Adapt worker_threads Worker to Web Worker interface expected by AsyncDuckDB
    const listeners = new Map<any, any>();
    const worker = {
      postMessage: (message: any, transfer?: any[]) => nodeWorker.postMessage(message, transfer as any),
      onmessage: null as any,
      terminate: () => nodeWorker.terminate(),
      addEventListener: (type: string, listener: any) => {
        if (type !== 'message') {
          return;
        }
        const wrapped = (data: any) => listener({ data });
        listeners.set(listener, wrapped);
        nodeWorker.on('message', wrapped);
      },
      removeEventListener: (type: string, listener: any) => {
        if (type !== 'message') {
          return;
        }
        const wrapped = listeners.get(listener);
        if (wrapped) {
          nodeWorker.off('message', wrapped);
          listeners.delete(listener);
        }
      },
    };

    nodeWorker.on('message', (data) => {
      if (worker.onmessage) {
        // @ts-ignore
        worker.onmessage({ data });
      }
    });

    nodeWorker.on('error', (err) => {
      console.error('[DuckDB] Worker error:', err);
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
    // await this.conn.query(`SET custom_extension_repository = 'http://127.0.0.1:${this.port}'`);
    // await this.conn.query('SET extension_directory')
    // await this.conn.query('LOAD duckdb_gdx');
    await this.conn.query(`INSTALL duckdb_gdx from 'https://humusklimanetz-couch.thuenen.de/datasets/duckdb_gdx'`);
    await this.conn.query(`LOAD duckdb_gdx`);
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
    token?: CancellationToken
  ): Promise<string[]> {
    if (!this.conn) {
      throw new Error('DuckDB not initialized');
    }

    if (token?.isCancellationRequested) {
      throw new CancellationError();
    }

    const result = await this.conn.query(`
      SELECT value FROM gdx_domain_values('${registrationName}', '${symbol}', ${dimIndex})
    `);
    
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
