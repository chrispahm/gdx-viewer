import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { AsyncDuckDB, AsyncDuckDBConnection, ConsoleLogger } from '@duckdb/duckdb-wasm';
// Use web-worker@1.2.0 package which provides Web Worker API for Node.js
// This is the same package duckdb-wasm uses internally
import Worker from 'web-worker';

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
    // Start HTTP server for WASM extensions on dynamic port
    const repositoryDir = path.join(this.extensionPath, 'dist', 'wasm');
    
    this.server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const urlPath = req.url || '';
      try {
        const filePath = path.join(repositoryDir, urlPath);
        const content = await fs.readFile(filePath);
        res.setHeader('Content-Type', 'application/wasm');
        res.writeHead(200);
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, () => {
        const address = this.server!.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        resolve();
      });
    });

    // Initialize DuckDB-WASM with Node.js worker using web-worker package
    const nodeModulesPath = path.join(this.extensionPath, 'node_modules', '@duckdb', 'duckdb-wasm', 'dist');
    const workerPath = path.join(nodeModulesPath, 'duckdb-node-eh.worker.cjs');
    const wasmPath = path.join(nodeModulesPath, 'duckdb-eh.wasm');

    // Use web-worker package which provides Web Worker API for Node.js
    // Must use file:// URL format
    const workerUrl = pathToFileURL(workerPath).href;
    const worker = new Worker(workerUrl);
    
    this.db = new AsyncDuckDB(new ConsoleLogger(), worker);
    await this.db.instantiate(wasmPath);
    await this.db.open({ allowUnsignedExtensions: true });

    // Create a persistent connection for all queries
    this.conn = await this.db.connect();

    // Load the GDX extension
    await this.conn.query(`SET custom_extension_repository = 'http://localhost:${this.port}'`);
    await this.conn.query('LOAD duckdb_gdx');
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
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
