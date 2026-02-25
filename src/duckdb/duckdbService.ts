import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';

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

// DuckDB platform name for the current OS/arch
const DUCKDB_PLATFORM_MAP: Record<string, string> = {
  'darwin-arm64': 'osx_arm64',
  'darwin-x64': 'osx_amd64',
  'linux-x64': 'linux_amd64',
  'win32-x64': 'windows_amd64',
};

export class DuckdbService {
  private instance: DuckDBInstance | null = null;
  private conn: DuckDBConnection | null = null;
  private tempDir: string | null = null;
  private dbPath: string = ':memory:';
  private extensionPath: string | undefined;

  async initialize(dbPath?: string, extensionPath?: string): Promise<void> {
    if (dbPath !== undefined) {
      this.dbPath = dbPath;
    }
    if (extensionPath !== undefined) {
      this.extensionPath = extensionPath;
    }

    const t0 = performance.now();
    const elapsed = () => `${(performance.now() - t0).toFixed(0)}ms`;

    console.log(`[DuckDB] [${elapsed()}] Creating DuckDB instance (${this.dbPath})...`);
    this.instance = await DuckDBInstance.create(this.dbPath);
    console.log(`[DuckDB] [${elapsed()}] Instance created`);

    this.conn = await this.instance.connect();
    console.log(`[DuckDB] [${elapsed()}] Connection established`);

    // Load extensions — try bundled files first, fall back to network install
    await this.loadExtension('excel', elapsed);
    await this.loadExtension('gdx', elapsed);

    // Warmup query to trigger any lazy initialization
    await this.conn.run('SELECT 1');
    console.log(`[DuckDB] [${elapsed()}] Warmup query complete`);

    // Get version for logging
    const result = await this.conn.run('SELECT extension_name, extension_version FROM duckdb_extensions()');
    const rows = await result.getRowObjectsJS();
    console.log('[DuckDB] Loaded extensions:\n');
    for (const row of rows) {
      console.log(`- ${row.extension_name}: ${row.extension_version}\n`);
    }
    console.log(`[DuckDB] [${elapsed()}] Initialization complete`);
  }

  /**
   * Try to LOAD an extension from the bundled path. If the bundled file doesn't
   * exist (dev mode), fall back to INSTALL + LOAD from the network.
   */
  private async loadExtension(name: string, elapsed: () => string): Promise<void> {
    if (!this.conn) {
      throw new Error('DuckDB not initialized');
    }

    const bundledPath = this.findBundledExtension(name);
    if (bundledPath) {
      console.log(`[DuckDB] [${elapsed()}] Loading bundled ${name} extension from ${bundledPath}...`);
      await this.conn.run(`LOAD '${bundledPath.replace(/'/g, "''")}'`);
      console.log(`[DuckDB] [${elapsed()}] ${name} extension loaded (bundled)`);
      return;
    }

    // Fallback: network install
    console.log(`[DuckDB] [${elapsed()}] Bundled ${name} extension not found, installing from network...`);
    if (name === 'gdx') {
      await this.conn.run('INSTALL gdx FROM community');
    } else {
      await this.conn.run(`INSTALL ${name}`);
    }
    await this.conn.run(`LOAD ${name}`);
    console.log(`[DuckDB] [${elapsed()}] ${name} extension loaded (network)`);
  }

  /**
   * Resolve the path to a bundled .duckdb_extension file, or return undefined
   * if no bundled copy exists.
   *
   * Layout inside the VSIX:
   *   Platform-specific build: duckdb-extensions/bundle/<name>.duckdb_extension
   *   Universal build:         duckdb-extensions/bundle/<platform>/<name>.duckdb_extension
   */
  private findBundledExtension(name: string): string | undefined {
    if (!this.extensionPath) {
      return undefined;
    }

    const bundleDir = path.join(this.extensionPath, 'duckdb-extensions', 'bundle');
    const fileName = `${name}.duckdb_extension`;

    // Platform-specific build (flat)
    const flat = path.join(bundleDir, fileName);
    try {
      fsSync.accessSync(flat);
      return flat;
    } catch {
      // Not found — try universal layout
    }

    // Universal build (nested by platform)
    const platformKey = `${process.platform}-${process.arch}`;
    const duckdbPlatform = DUCKDB_PLATFORM_MAP[platformKey];
    if (duckdbPlatform) {
      const nested = path.join(bundleDir, duckdbPlatform, fileName);
      try {
        fsSync.accessSync(nested);
        return nested;
      } catch {
        // Not found
      }
    }

    return undefined;
  }

  async registerFile(source: string, bytes?: Uint8Array): Promise<string> {
    // For local files (no bytes provided), return the path directly.
    // DuckDB reads from disk on each query, so no registration needed.
    if (!bytes) {
      return source;
    }

    // For remote files (where we have bytes), write to a temp file
    if (!this.tempDir) {
      this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gdx-'));
    }

    const randomSuffix = Math.random().toString(16).slice(2, 8);
    const hash = this.hashString(source + randomSuffix);
    const tempPath = path.join(this.tempDir, `gdx_${hash}.gdx`);

    await fs.writeFile(tempPath, bytes);
    return tempPath;
  }

  async unregisterFile(filePath: string): Promise<void> {
    // Only delete if it's a temp file we created
    if (this.tempDir && filePath.startsWith(this.tempDir)) {
      try {
        await fs.unlink(filePath);
      } catch {
        // Ignore if already deleted
      }
    }
  }

  async getSymbols(filePath: string): Promise<GdxSymbol[]> {
    if (!this.conn) {
      throw new Error('DuckDB not initialized');
    }

    const escapedPath = filePath.replace(/'/g, "''");
    await this.conn.run(`PRAGMA gdx_preload('${escapedPath}', force_reload=true);`);
    const result = await this.conn.run(`
      SELECT symbol_name, symbol_type, dimension_count, record_count
      FROM gdx_symbols('${escapedPath}')
      ORDER BY symbol_name
    `);

    const rows = await result.getRowObjectsJS();
    console.log(`[DuckDB] Retrieved ${rows.length} symbols from ${filePath}`);
    return rows.map((row) => ({
      name: row.symbol_name as string,
      type: row.symbol_type as string,
      dimensionCount: Number(row.dimension_count),
      recordCount: Number(row.record_count),
    }));
  }

  async getDomainValues(
    filePath: string,
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

    const escapedPath = filePath.replace(/'/g, "''");

    // Build SQL with optional dimension filters
    let sql = `SELECT value FROM gdx_domain_values('${escapedPath}', '${symbol}', ${dimIndex}`;

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

    const result = await this.conn.run(sql);

    if (token?.isCancellationRequested) {
      throw new CancellationError();
    }

    const rows = await result.getRowObjectsJS();
    return rows.map((row) => row.value as string);
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    if (!this.conn) {
      throw new Error('DuckDB not initialized');
    }

    const result = await this.conn.run(sql);
    const columns = result.columnNames();
    const rawRows = await result.getRowObjectsJS();

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

  async createBackgroundConnection(): Promise<DuckDBConnection> {
    if (!this.instance) {
      throw new Error('DuckDB not initialized');
    }
    return this.instance.connect();
  }

  async executeQueryOnConnection(conn: DuckDBConnection, sql: string): Promise<QueryResult> {
    const result = await conn.run(sql);
    const columns = result.columnNames();
    const rawRows = await result.getRowObjectsJS();

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
    await this.conn.run(copySql);
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

  async reinitialize(): Promise<void> {
    // Close existing connection and instance (they may throw if DuckDB is in fatal state)
    if (this.conn) {
      try { this.conn.disconnectSync(); } catch { /* fatal state — ignore */ }
      this.conn = null;
    }
    if (this.instance) {
      try { this.instance.closeSync(); } catch { /* fatal state — ignore */ }
      this.instance = null;
    }
    // Do NOT delete tempDir — remote files must survive reinitialize
    // Reuses stored dbPath and extensionPath from the original initialize() call
    await this.initialize();
  }

  async dispose(): Promise<void> {
    if (this.conn) {
      try { this.conn.disconnectSync(); } catch { /* may be in fatal state */ }
      this.conn = null;
    }
    if (this.instance) {
      try { this.instance.closeSync(); } catch { /* may be in fatal state */ }
      this.instance = null;
    }
    // Clean up temp directory
    if (this.tempDir) {
      try {
        await fs.rm(this.tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      this.tempDir = null;
    }
  }
}
