import * as vscode from 'vscode';
import { DuckdbService, GdxSymbol } from './duckdbService';

export interface GdxDocumentState {
  uri: vscode.Uri;
  registrationName: string;
  symbols: GdxSymbol[];
  domainValuesCache: Map<string, Map<number, string[]>>;
  filterLoadingCts: vscode.CancellationTokenSource | null;
  isFilterLoading: boolean;
}

export class GdxDocumentManager {
  private documents = new Map<string, GdxDocumentState>();
  private duckdbService: DuckdbService;
  private _onDocumentOpened = new vscode.EventEmitter<GdxDocumentState>();
  private _onDocumentClosed = new vscode.EventEmitter<vscode.Uri>();
  private _onFilterLoadingChanged = new vscode.EventEmitter<{ uri: vscode.Uri; isLoading: boolean }>();
  private _onDomainValuesLoaded = new vscode.EventEmitter<{ uri: vscode.Uri; columnName: string; values: string[] }>();

  readonly onDocumentOpened = this._onDocumentOpened.event;
  readonly onDocumentClosed = this._onDocumentClosed.event;
  readonly onFilterLoadingChanged = this._onFilterLoadingChanged.event;
  readonly onDomainValuesLoaded = this._onDomainValuesLoaded.event;

  constructor(duckdbService: DuckdbService) {
    this.duckdbService = duckdbService;
  }

  async openDocument(uri: vscode.Uri, bytes: Uint8Array): Promise<GdxDocumentState> {
    const key = uri.toString();
    
    // Return existing document if already open
    const existing = this.documents.get(key);
    if (existing) {
      return existing;
    }

    // Register file with DuckDB
    const registrationName = await this.duckdbService.registerGdxFile(uri.toString(), bytes);
    
    // Get symbols
    const symbols = await this.duckdbService.getSymbols(registrationName);

    const state: GdxDocumentState = {
      uri,
      registrationName,
      symbols,
      domainValuesCache: new Map(),
      filterLoadingCts: null,
      isFilterLoading: false,
    };

    this.documents.set(key, state);
    this._onDocumentOpened.fire(state);

    // Note: Filter loading is NOT started here - it will be triggered by the webview
    // after the initial data query completes, to avoid blocking the data display

    return state;
  }

  async closeDocument(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const state = this.documents.get(key);
    
    if (state) {
      // Cancel any pending filter loading
      if (state.filterLoadingCts) {
        state.filterLoadingCts.cancel();
        state.filterLoadingCts.dispose();
      }

      // Unregister file from DuckDB
      await this.duckdbService.unregisterFile(state.registrationName);
      
      this.documents.delete(key);
      this._onDocumentClosed.fire(uri);
    }
  }

  getDocument(uri: vscode.Uri): GdxDocumentState | undefined {
    return this.documents.get(uri.toString());
  }

  async getDomainValues(
    uri: vscode.Uri,
    symbol: string,
    dimIndex: number
  ): Promise<string[]> {
    const state = this.documents.get(uri.toString());
    if (!state) {
      throw new Error('Document not open');
    }

    // Check cache first
    const symbolCache = state.domainValuesCache.get(symbol);
    if (symbolCache?.has(dimIndex)) {
      return symbolCache.get(dimIndex)!;
    }

    // Fetch from DuckDB
    const values = await this.duckdbService.getDomainValues(
      state.registrationName,
      symbol,
      dimIndex
    );

    // Cache the result
    if (!state.domainValuesCache.has(symbol)) {
      state.domainValuesCache.set(symbol, new Map());
    }
    state.domainValuesCache.get(symbol)!.set(dimIndex, values);

    return values;
  }

  async startFilterLoading(uri: vscode.Uri, symbol: string): Promise<void> {
    const state = this.documents.get(uri.toString());
    if (!state) {
      return;
    }

    // Cancel any existing filter loading
    if (state.filterLoadingCts) {
      state.filterLoadingCts.cancel();
      state.filterLoadingCts.dispose();
    }

    const symbolInfo = state.symbols.find(s => s.name === symbol);
    if (!symbolInfo || symbolInfo.dimensionCount === 0) {
      return;
    }

    // Set loading state and notify before starting async work
    state.isFilterLoading = true;
    this._onFilterLoadingChanged.fire({ uri, isLoading: true });
    
    // Start actual loading (not awaited to run in background)
    this.startFilterLoadingInternal(uri, symbol, symbolInfo);
  }

  private async startFilterLoadingInternal(
    uri: vscode.Uri,
    symbol: string,
    symbolInfo?: GdxSymbol
  ): Promise<void> {
    const state = this.documents.get(uri.toString());
    if (!state) {
      return;
    }

    // Get symbol info if not provided (for backward compatibility)
    const info = symbolInfo || state.symbols.find(s => s.name === symbol);
    if (!info || info.dimensionCount === 0) {
      state.isFilterLoading = false;
      this._onFilterLoadingChanged.fire({ uri, isLoading: false });
      return;
    }

    state.filterLoadingCts = new vscode.CancellationTokenSource();

    try {
      // Load all dimensions for the symbol
      for (let dim = 1; dim <= info.dimensionCount; dim++) {
        if (state.filterLoadingCts.token.isCancellationRequested) {
          break;
        }

        await this.duckdbService.getDomainValues(
          state.registrationName,
          symbol,
          dim,
          state.filterLoadingCts.token
        ).then(values => {
          // Cache the values
          if (!state.domainValuesCache.has(symbol)) {
            state.domainValuesCache.set(symbol, new Map());
          }
          state.domainValuesCache.get(symbol)!.set(dim, values);
          
          // Emit event so webview can be notified
          const columnName = `dim_${dim}`;
          this._onDomainValuesLoaded.fire({ uri, columnName, values });
        }).catch(err => {
          if (!(err instanceof vscode.CancellationError)) {
            console.error(`Error loading dimension ${dim} for ${symbol}:`, err);
          }
        });
      }
    } finally {
      state.isFilterLoading = false;
      state.filterLoadingCts = null;
      this._onFilterLoadingChanged.fire({ uri, isLoading: false });
    }
  }

  cancelFilterLoading(uri: vscode.Uri): void {
    const state = this.documents.get(uri.toString());
    if (state?.filterLoadingCts) {
      state.filterLoadingCts.cancel();
    }
  }

  async executeQuery(uri: vscode.Uri, sql: string) {
    const state = this.documents.get(uri.toString());
    if (!state) {
      throw new Error('Document not open');
    }

    // Replace placeholder with actual registration name
    const actualSql = sql.replace(/__GDX_FILE__/g, state.registrationName);
    return this.duckdbService.executeQuery(actualSql);
  }

  async exportQuery(
    uri: vscode.Uri,
    sql: string,
    format: 'csv' | 'parquet' | 'excel',
    destinationPath: string
  ): Promise<void> {
    const state = this.documents.get(uri.toString());
    if (!state) {
      throw new Error('Document not open');
    }

    let actualSql = sql.replace(/__GDX_FILE__/g, state.registrationName);
    // also remove any LIMIT/OFFSET clauses for export
    actualSql = actualSql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?/gi, '');
    console.log('[GDX Document Manager] Exporting query after removing LIMIT/OFFSET:', actualSql);
    console.log('[GDX Document Manager] Exporting query:', actualSql, '->', destinationPath);
    await this.duckdbService.exportQuery(actualSql, format, destinationPath);
  }

  dispose(): void {
    // Cancel all pending operations and close all documents
    for (const state of this.documents.values()) {
      if (state.filterLoadingCts) {
        state.filterLoadingCts.cancel();
        state.filterLoadingCts.dispose();
      }
    }
    this.documents.clear();
    this._onDocumentOpened.dispose();
    this._onDocumentClosed.dispose();
    this._onFilterLoadingChanged.dispose();
    this._onDomainValuesLoaded.dispose();
  }
}
