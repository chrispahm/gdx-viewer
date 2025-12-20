import { useEffect, useState, useCallback } from "react";
import { DataTable } from "./components/DataTable";
import { SqlToolbar } from "./components/SqlToolbar";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { type DisplayAttributes } from "./components/AttributesPanel";
import { wsClient } from "./wsClient";

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

// Filter types for SQL generation
export interface NumericFilterState {
  min?: number;
  max?: number;
  exclude: boolean;
  showEPS: boolean;
  showNA: boolean;
  showPosInf: boolean;
  showNegInf: boolean;
  showUNDF: boolean;
  showAcronyms: boolean;
}

export interface TextFilterState {
  selectedValues: string[];
}

export type FilterValue = NumericFilterState | TextFilterState;

export interface ColumnFilter {
  columnName: string;
  filterValue: FilterValue;
}

export interface ColumnSort {
  columnName: string;
  direction: 'asc' | 'desc';
}

// Helper to check if a filter is numeric
function isNumericFilter(filter: FilterValue): filter is NumericFilterState {
  return 'exclude' in filter;
}

// SQL Builder function
function buildSqlQuery(
  symbolName: string,
  filters: ColumnFilter[],
  sorts: ColumnSort[],
  pageSize: number,
  pageIndex: number
): string {
  let sql = `SELECT * FROM read_gdx('__GDX_FILE__', '${symbolName}')`;

  // Build WHERE clause from filters
  const whereClauses: string[] = [];
  for (const filter of filters) {
    const { columnName, filterValue } = filter;

    if (isNumericFilter(filterValue)) {
      // Numeric filter with range and special values
      const conditions: string[] = [];

      // Check if any special values are disabled (i.e., we need to filter them out)
      const hasDisabledSpecialValues =
        !filterValue.showEPS ||
        !filterValue.showNA ||
        !filterValue.showPosInf ||
        !filterValue.showNegInf ||
        !filterValue.showUNDF;

      // If ALL special values are shown and there's no range, skip this filter
      if (!hasDisabledSpecialValues && filterValue.min === undefined && filterValue.max === undefined) {
        continue;
      }

      // Build conditions for special values that should be EXCLUDED
      const excludedSpecialValues: string[] = [];
      if (!filterValue.showEPS) excludedSpecialValues.push('EPS');
      if (!filterValue.showNA) excludedSpecialValues.push('NA');
      if (!filterValue.showUNDF) excludedSpecialValues.push('UNDF');

      // Handle infinity values
      if (!filterValue.showPosInf) {
        excludedSpecialValues.push('+INF');
        conditions.push(`"${columnName}" != CAST('Infinity' AS DOUBLE)`);
      }
      if (!filterValue.showNegInf) {
        excludedSpecialValues.push('-INF');
        conditions.push(`"${columnName}" != CAST('-Infinity' AS DOUBLE)`);
      }

      // Exclude special string values
      if (excludedSpecialValues.length > 0) {
        const excludeList = excludedSpecialValues.map(v => `'${v}'`).join(', ');
        conditions.push(`CAST("${columnName}" AS VARCHAR) NOT IN (${excludeList})`);
      }

      // Range conditions
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
        whereClauses.push(`(${clause})`);
      }
    } else {
      // Text filter with selected values
      if (filterValue.selectedValues.length === 0) {
        continue; // No values selected means show all
      }
      const valueList = filterValue.selectedValues.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');
      whereClauses.push(`"${columnName}" IN (${valueList})`);
    }
  }

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }

  // Add ORDER BY clause
  if (sorts.length > 0) {
    const orderClauses = sorts.map(sort =>
      `"${sort.columnName}" ${sort.direction.toUpperCase()}`
    );
    sql += ` ORDER BY ${orderClauses.join(', ')}`;
  }

  // Add pagination
  sql += ` LIMIT ${pageSize} OFFSET ${pageIndex * pageSize}`;

  return sql;
}

interface VSCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeApi;

const vscode = acquireVsCodeApi();

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
  const [pageSize, setPageSize] = useState(1000);
  const [totalRows, setTotalRows] = useState(0);
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [sorts, setSorts] = useState<ColumnSort[]>([]);
  const [domainValues, setDomainValues] = useState<Map<string, string[]>>(new Map());
  const [connected, setConnected] = useState(false);
  // Cache for count queries keyed by SQL string - avoids redundant expensive COUNT queries
  const [countCache, setCountCache] = useState<Map<string, number>>(new Map());
  const [displayAttributes, setDisplayAttributes] = useState<DisplayAttributes>({
    squeezeDefaults: true,
    squeezeTrailingZeroes: false,
    format: 'g-format',
    precision: 6,
  });

  // Execute query via WebSocket
  const executeQuery = useCallback(async (sql: string) => {
    if (!connected) {
      setError("Not connected to server");
      return;
    }
    setIsLoading(true);
    setError(null);

    // Let React render the loading state before doing work
    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      const result = await wsClient.request<QueryResult>("executeQuery", { sql });
      setResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed");
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }, [connected]);

  const executeQueryWithFiltersAndSorts = useCallback(
    async (symbol: GdxSymbol, newPageIndex: number, newPageSize: number, newFilters: ColumnFilter[], newSorts: ColumnSort[]) => {
      // Set loading state first
      setIsLoading(true);
      setError(null);

      // Use setTimeout to let React render the loading state before doing any work
      await new Promise(resolve => setTimeout(resolve, 0));

      // Build the query for data
      const sql = buildSqlQuery(symbol.name, newFilters, newSorts, newPageSize, newPageIndex);
      setQuery(sql);

      try {
        // Execute data query
        const dataResult = await wsClient.request<QueryResult>("executeQuery", { sql });
        setResult(dataResult);
        setIsLoading(false);

        // Only run count query if there are active filters
        // Without filters, we use symbol.recordCount from metadata (already set in handleSymbolSelect)
        if (newFilters.length > 0) {
          // Build count query (without ORDER BY, LIMIT, OFFSET since those don't affect count)
          const countSql = buildSqlQuery(symbol.name, newFilters, [], 0, 0)
            .replace(/^SELECT \* FROM/, 'SELECT COUNT(*) as count FROM')
            .replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?$/i, '');

          // Check count cache - only run count query if not cached
          const cachedCount = countCache.get(countSql);
          if (cachedCount !== undefined) {
            setTotalRows(cachedCount);
          } else {
            // Run count query in background and cache result
            wsClient.request<QueryResult>("executeQuery", { sql: countSql })
              .then(countResult => {
                if (countResult.rows.length > 0 && countResult.rows[0].count !== undefined) {
                  const count = typeof countResult.rows[0].count === 'bigint'
                    ? Number(countResult.rows[0].count)
                    : countResult.rows[0].count as number;
                  setTotalRows(count);
                  // Cache the result
                  setCountCache(prev => {
                    const updated = new Map(prev);
                    updated.set(countSql, count);
                    return updated;
                  });
                }
              })
              .catch(err => console.error('[Count query error]', err));
          }
        } else {
          // No filters - use metadata count
          setTotalRows(symbol.recordCount);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Query failed");
        setResult(null);
        setIsLoading(false);
      }
    },
    [countCache]
  );

  const loadDomainValues = useCallback(async (symbol: GdxSymbol) => {
    setIsFilterLoading(true);
    try {
      // Load domain values for each dimension
      for (let dim = 1; dim <= symbol.dimensionCount; dim++) {
        try {
          const result = await wsClient.request<{ values: string[] }>("getDomainValues", {
            symbol: symbol.name,
            dimIndex: dim,
          });
          const columnName = `dim_${dim}`;
          setDomainValues(prev => {
            const updated = new Map(prev);
            updated.set(columnName, result.values);
            return updated;
          });
        } catch (err) {
          console.error(`Error loading dimension ${dim}:`, err);
        }
      }
    } finally {
      setIsFilterLoading(false);
    }
  }, []);

  const handleFiltersChange = useCallback(
    async (newFilters: ColumnFilter[]) => {
      if (!selectedSymbol) return;
      setFilters(newFilters);
      setPageIndex(0); // Reset to first page when filters change
      await executeQueryWithFiltersAndSorts(selectedSymbol, 0, pageSize, newFilters, sorts);
    },
    [selectedSymbol, pageSize, sorts, executeQueryWithFiltersAndSorts]
  );

  const handleSortsChange = useCallback(
    async (newSorts: ColumnSort[]) => {
      if (!selectedSymbol) return;
      setSorts(newSorts);
      setPageIndex(0);
      await executeQueryWithFiltersAndSorts(selectedSymbol, 0, pageSize, filters, newSorts);
    },
    [selectedSymbol, pageSize, filters, executeQueryWithFiltersAndSorts]
  );

  const handleResetFilters = useCallback(
    async () => {
      if (!selectedSymbol) return;
      setFilters([]);
      setSorts([]);
      setPageIndex(0);
      await executeQueryWithFiltersAndSorts(selectedSymbol, 0, pageSize, [], []);
      // Reload domain values
      loadDomainValues(selectedSymbol);
    },
    [selectedSymbol, pageSize, executeQueryWithFiltersAndSorts, loadDomainValues]
  );

  const handleSymbolSelect = useCallback(
    async (symbol: GdxSymbol) => {
      setSelectedSymbol(symbol);
      setPageIndex(0);
      setTotalRows(symbol.recordCount);
      setFilters([]);
      setSorts([]);
      setDomainValues(new Map());
      setCountCache(new Map()); // Clear count cache for new symbol

      // Build default query
      const sql = buildSqlQuery(symbol.name, [], [], pageSize, 0);
      setQuery(sql);

      vscode.postMessage({ type: "selectSymbol", symbol });
      await executeQuery(sql);

      // Load domain values in background
      loadDomainValues(symbol);
    },
    [pageSize, executeQuery, loadDomainValues]
  );

  const handlePageChange = useCallback(
    async (newPageIndex: number) => {
      if (!selectedSymbol) return;
      setPageIndex(newPageIndex);
      await executeQueryWithFiltersAndSorts(selectedSymbol, newPageIndex, pageSize, filters, sorts);
    },
    [selectedSymbol, pageSize, filters, sorts, executeQueryWithFiltersAndSorts]
  );

  const handlePageSizeChange = useCallback(
    async (newPageSize: number) => {
      if (!selectedSymbol) return;
      setPageSize(newPageSize);
      setPageIndex(0);
      await executeQueryWithFiltersAndSorts(selectedSymbol, 0, newPageSize, filters, sorts);
    },
    [selectedSymbol, filters, sorts, executeQueryWithFiltersAndSorts]
  );

  const handleExport = useCallback(
    async (format: 'csv' | 'parquet' | 'excel') => {
      if (!query || !selectedSymbol) return;
      setIsExporting(true);
      setError(null);
      try {
        // Request export path from extension (needs file picker)
        vscode.postMessage({ type: 'exportData', format, query });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Export failed');
      } finally {
        setIsExporting(false);
      }
    },
    [query, selectedSymbol]
  );

  const handleCancelFilterLoading = useCallback(() => {
    // Cancel is now a no-op since loading happens via individual requests
    setIsFilterLoading(false);
  }, []);

  // Handle messages from extension
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const message = event.data;
      console.log('[GDX Webview] Received message:', message.type);

      switch (message.type) {
        case "init":
          // Connect to WebSocket server
          console.log('[GDX Webview] Connecting to server on port', message.serverPort);
          try {
            await wsClient.connect(message.serverPort);
            wsClient.setDocumentId(message.documentId);
            setConnected(true);

            // Open document on server
            console.log('[GDX Webview] Opening document:', message.filePath);
            const result = await wsClient.request<{ symbols: GdxSymbol[] }>("openDocument", {
              filePath: message.filePath,
              documentId: message.documentId,
            });

            const syms = result.symbols;
            setSymbols(syms);

            // Notify extension about symbols for tree view
            vscode.postMessage({ type: "symbolsLoaded", symbols: syms });

            // Auto-select first symbol
            if (syms.length > 0) {
              const firstSymbol = syms[0];
              setSelectedSymbol(firstSymbol);
              setTotalRows(firstSymbol.recordCount);
              const sql = buildSqlQuery(firstSymbol.name, [], [], 1000, 0);
              setQuery(sql);

              setIsLoading(true);
              try {
                const queryResult = await wsClient.request<QueryResult>("executeQuery", { sql });
                setResult(queryResult);
                // Load domain values in background
                loadDomainValues(firstSymbol);
              } catch (err) {
                console.error('[GDX Webview] Query error:', err);
                setError(err instanceof Error ? err.message : "Query failed");
              } finally {
                setIsLoading(false);
              }
            }
          } catch (err) {
            console.error('[GDX Webview] Failed to connect:', err);
            setError(err instanceof Error ? err.message : "Failed to connect to server");
          }
          break;

        case "selectSymbol":
          handleSymbolSelect(message.symbol);
          break;

        case "exportPath":
          // Extension provided export path, execute export on server
          // TODO: Implement export via WebSocket
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    console.log('[GDX Webview] Sending ready message');
    vscode.postMessage({ type: "ready" });

    return () => window.removeEventListener("message", handleMessage);
  }, [loadDomainValues, handleSymbolSelect]);

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
        hasActiveFilters={filters.length > 0}
        onResetFilters={handleResetFilters}
      />

      {error && (
        <div style={{
          padding: '8px 12px',
          backgroundColor: 'var(--vscode-inputValidation-errorBackground)',
          color: 'var(--vscode-inputValidation-errorForeground)',
          borderBottom: '1px solid var(--vscode-inputValidation-errorBorder)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px'
        }}>
          <span>{error}</span>
          {(filters.length > 0 || sorts.length > 0) && (
            <button
              onClick={handleResetFilters}
              style={{
                padding: '4px 12px',
                backgroundColor: 'var(--vscode-button-secondaryBackground)',
                color: 'var(--vscode-button-secondaryForeground)',
                border: 'none',
                borderRadius: '3px',
                cursor: 'pointer',
                fontFamily: 'var(--vscode-font-family)',
                fontSize: 'var(--vscode-font-size)',
              }}
            >
              Reset Filters
            </button>
          )}
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
            filters={filters}
            sorts={sorts}
            onFiltersChange={handleFiltersChange}
            onSortsChange={handleSortsChange}
            domainValues={domainValues}
            dimensionCount={selectedSymbol?.dimensionCount ?? 0}
          />
        ) : !isLoading && !selectedSymbol ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--vscode-descriptionForeground)'
          }}>
            {connected
              ? (symbols.length > 0
                ? "Select a symbol from the sidebar to view data"
                : "Loading symbols...")
              : "Connecting to server..."}
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
