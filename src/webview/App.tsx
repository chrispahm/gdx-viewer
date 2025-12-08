import { useEffect, useState, useCallback } from "react";
import { DataTable } from "./components/DataTable";
import { SqlToolbar } from "./components/SqlToolbar";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { type DisplayAttributes } from "./components/AttributesPanel";

interface GdxSymbol {
  name: string;
  type: string;
  dimensionCount: number;
  recordCount: number;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

interface VSCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeApi;

const vscode = acquireVsCodeApi();

let requestId = 0;
const pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();

function sendRequest<T>(type: string, payload: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject });
    vscode.postMessage({ type, requestId: id, ...payload });
  });
}

export function App() {
  const [symbols, setSymbols] = useState<GdxSymbol[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState<GdxSymbol | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFilterLoading, setIsFilterLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [totalRows, setTotalRows] = useState(0);
  const [displayAttributes, setDisplayAttributes] = useState<DisplayAttributes>({
    squeezeDefaults: true,
    squeezeTrailingZeroes: false,
    format: 'g-format',
    precision: 6,
  });

  const executeQuery = useCallback(async (sql: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await sendRequest<QueryResult>("executeQuery", { sql });
      setResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed");
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleSymbolSelect = useCallback(
    async (symbol: GdxSymbol) => {
      setSelectedSymbol(symbol);
      setPageIndex(0);
      setTotalRows(symbol.recordCount);

      // Build default query
      const sql = `SELECT * FROM read_gdx('__GDX_FILE__', '${symbol.name}') LIMIT ${pageSize} OFFSET 0`;
      setQuery(sql);

      vscode.postMessage({ type: "selectSymbol", symbol });
      await executeQuery(sql);
    },
    [pageSize, executeQuery]
  );

  const handlePageChange = useCallback(
    async (newPageIndex: number) => {
      if (!selectedSymbol) return;
      setPageIndex(newPageIndex);
      const offset = newPageIndex * pageSize;
      const sql = `SELECT * FROM read_gdx('__GDX_FILE__', '${selectedSymbol.name}') LIMIT ${pageSize} OFFSET ${offset}`;
      setQuery(sql);
      await executeQuery(sql);
    },
    [selectedSymbol, pageSize, executeQuery]
  );

  const handlePageSizeChange = useCallback(
    async (newPageSize: number) => {
      if (!selectedSymbol) return;
      setPageSize(newPageSize);
      setPageIndex(0);
      const sql = `SELECT * FROM read_gdx('__GDX_FILE__', '${selectedSymbol.name}') LIMIT ${newPageSize} OFFSET 0`;
      setQuery(sql);
      await executeQuery(sql);
    },
    [selectedSymbol, executeQuery]
  );

  const handleExport = useCallback(
    async (format: 'csv' | 'parquet' | 'excel') => {
      if (!query) return;
      setIsExporting(true);
      setError(null);
      try {
        await sendRequest('exportData', { format, query });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Export failed');
      } finally {
        setIsExporting(false);
      }
    },
    [query]
  );

  const handleCancelFilterLoading = useCallback(() => {
    vscode.postMessage({ type: "cancelFilterLoading" });
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      console.log('[GDX Webview] Received message:', message.type, message);

      switch (message.type) {
        case "init":
          console.log('[GDX Webview] Init with symbols:', message.symbols?.length);
          setSymbols(message.symbols);
          setIsFilterLoading(message.isFilterLoading);
          // Auto-select first symbol if available
          if (message.symbols.length > 0) {
            const firstSymbol = message.symbols[0];
            setSelectedSymbol(firstSymbol);
            setPageIndex(0);
            setTotalRows(firstSymbol.recordCount);
            const sql = `SELECT * FROM read_gdx('__GDX_FILE__', '${firstSymbol.name}') LIMIT 100 OFFSET 0`;
            setQuery(sql);
            // Execute query for first symbol, then start filter loading
            setIsLoading(true);
            sendRequest<QueryResult>("executeQuery", { sql })
              .then(result => {
                console.log('[GDX Webview] Query result:', result);
                setResult(result);
                setIsLoading(false);
                // Start filter loading AFTER data loading is complete
                // Use setTimeout to ensure React state update happens first
                setTimeout(() => {
                  vscode.postMessage({ type: "startFilterLoading", symbol: firstSymbol.name });
                }, 0);
              })
              .catch(err => {
                console.error('[GDX Webview] Query error:', err);
                setError(err instanceof Error ? err.message : "Query failed");
                setIsLoading(false);
              });
          }
          break;

        case "selectSymbol":
          handleSymbolSelect(message.symbol);
          break;

        case "queryResult":
          console.log('[GDX Webview] Query result for request:', message.requestId);
          if (pendingRequests.has(message.requestId)) {
            pendingRequests.get(message.requestId)!.resolve(message.result);
            pendingRequests.delete(message.requestId);
          }
          break;

        case "queryError":
          console.error('[GDX Webview] Query error:', message.error);
          if (pendingRequests.has(message.requestId)) {
            pendingRequests.get(message.requestId)!.reject(new Error(message.error));
            pendingRequests.delete(message.requestId);
          }
          break;

        case "exportResult":
          if (pendingRequests.has(message.requestId)) {
            pendingRequests.get(message.requestId)!.resolve(message.path);
            pendingRequests.delete(message.requestId);
          }
          break;

        case "exportError":
          if (pendingRequests.has(message.requestId)) {
            pendingRequests.get(message.requestId)!.reject(new Error(message.error));
            pendingRequests.delete(message.requestId);
          }
          break;

        case "filterLoadingChanged":
          setIsFilterLoading(message.isLoading);
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    console.log('[GDX Webview] Sending ready message');
    vscode.postMessage({ type: "ready" });

    return () => window.removeEventListener("message", handleMessage);
  }, []); // Remove handleSymbolSelect dependency to avoid re-registering

  return (
    <div style={{ 
      display: 'flex', 
      flexDirection: 'column', 
      height: '100vh',
      backgroundColor: 'var(--vscode-editor-background)',
      color: 'var(--vscode-editor-foreground)'
    }}>
      <SqlToolbar
        defaultQuery={query}
        onExecute={executeQuery}
        isLoading={isLoading}
        displayAttributes={displayAttributes}
        onAttributesChange={setDisplayAttributes}
        onExport={handleExport}
        isExporting={isExporting}
      />

      {error && (
        <div className="error-message">
          {error}
        </div>
      )}

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {result ? (
          <DataTable
            columns={result.columns}
            data={result.rows}
            pageIndex={pageIndex}
            pageSize={pageSize}
            totalRows={totalRows}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            displayAttributes={displayAttributes}
          />
        ) : !isLoading && !selectedSymbol ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--vscode-descriptionForeground)'
          }}>
            {symbols.length > 0
              ? "Select a symbol from the sidebar to view data"
              : "Loading symbols..."}
          </div>
        ) : null}

        <LoadingOverlay
          isLoading={isLoading}
          isFilterLoading={isFilterLoading}
          onCancelFilterLoading={handleCancelFilterLoading}
        />
      </div>
    </div>
  );
}
