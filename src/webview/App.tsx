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
      
      // Handle numeric range
      if (filterValue.min !== undefined || filterValue.max !== undefined) {
        const rangeConditions: string[] = [];
        if (filterValue.min !== undefined) {
          rangeConditions.push(`"${columnName}" >= ${filterValue.min}`);
        }
        if (filterValue.max !== undefined) {
          rangeConditions.push(`"${columnName}" <= ${filterValue.max}`);
        }
        const rangeClause = rangeConditions.join(' AND ');
        
        if (filterValue.exclude) {
          // Exclude range - must be outside the range AND be a valid number
          conditions.push(`("${columnName}" IS NOT NULL AND isfinite("${columnName}") AND NOT (${rangeClause}))`);
        } else {
          // Include range
          conditions.push(`(${rangeClause})`);
        }
      }
      
      // If not all special values are shown, we need to explicitly allow/disallow them
      if (hasDisabledSpecialValues) {
        const allowedSpecialConditions: string[] = [];
        
        // NULL values (EPS, NA, UNDF)
        if (filterValue.showEPS || filterValue.showNA || filterValue.showUNDF) {
          allowedSpecialConditions.push(`"${columnName}" IS NULL`);
        }
        
        // Infinity values
        if (filterValue.showPosInf) {
          allowedSpecialConditions.push(`"${columnName}" = 'Infinity'::DOUBLE`);
        }
        if (filterValue.showNegInf) {
          allowedSpecialConditions.push(`"${columnName}" = '-Infinity'::DOUBLE`);
        }
        
        if (allowedSpecialConditions.length > 0) {
          conditions.push(`(${allowedSpecialConditions.join(' OR ')})`);
        }
      }
      
      if (conditions.length > 0) {
        whereClauses.push(`(${conditions.join(' OR ')})`);
      }
    } else {
      // Text filter with selected values
      if (filterValue.selectedValues.length > 0) {
        const escapedValues = filterValue.selectedValues.map(v => `'${v.replace(/'/g, "''")}'`);
        whereClauses.push(`"${columnName}" IN (${escapedValues.join(', ')})`);
      }
    }
  }
  
  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }
  
  // Build ORDER BY clause from sorts
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
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [sorts, setSorts] = useState<ColumnSort[]>([]);
  const [domainValues, setDomainValues] = useState<Map<string, string[]>>(new Map());
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

  const executeQueryWithFiltersAndSorts = useCallback(
    async (symbol: GdxSymbol, newPageIndex: number, newPageSize: number, newFilters: ColumnFilter[], newSorts: ColumnSort[]) => {
      // Build the query for data
      const sql = buildSqlQuery(symbol.name, newFilters, newSorts, newPageSize, newPageIndex);
      setQuery(sql);
      
      // Also execute a count query to get total filtered rows
      const countSql = buildSqlQuery(symbol.name, newFilters, [], 0, 0)
        .replace(/^SELECT \* FROM/, 'SELECT COUNT(*) as count FROM')
        .replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?$/i, '');
      
      setIsLoading(true);
      setError(null);
      
      try {
        // Execute both queries in parallel
        const [dataResult, countResult] = await Promise.all([
          sendRequest<QueryResult>("executeQuery", { sql }),
          sendRequest<QueryResult>("executeQuery", { sql: countSql })
        ]);
        
        setResult(dataResult);
        
        // Update total rows based on count query
        if (countResult.rows.length > 0 && countResult.rows[0].count !== undefined) {
          const count = typeof countResult.rows[0].count === 'bigint' 
            ? Number(countResult.rows[0].count)
            : countResult.rows[0].count as number;
          setTotalRows(count);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Query failed");
        setResult(null);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

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
      setPageIndex(0); // Reset to first page when sorts change
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
    },
    [selectedSymbol, pageSize, executeQueryWithFiltersAndSorts]
  );

  const handleSymbolSelect = useCallback(
    async (symbol: GdxSymbol) => {
      setSelectedSymbol(symbol);
      setPageIndex(0);
      setTotalRows(symbol.recordCount);
      setFilters([]); // Reset filters when changing symbols
      setSorts([]); // Reset sorts when changing symbols

      // Build default query
      const sql = buildSqlQuery(symbol.name, [], [], pageSize, 0);
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
        // Build export query - strip LIMIT/OFFSET on backend
        await sendRequest('exportData', { format, query });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Export failed');
      } finally {
        setIsExporting(false);
      }
    },
    [query, selectedSymbol]
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
            setFilters([]); // Reset filters
            setSorts([]); // Reset sorts
            const sql = buildSqlQuery(firstSymbol.name, [], [], 100, 0);
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

        case "domainValues":
          console.log('[GDX Webview] Received domain values:', message.columnName);
          if (message.values) {
            setDomainValues(prev => {
              const updated = new Map(prev);
              updated.set(message.columnName, message.values);
              return updated;
            });
          }
          break;

        case "domainValuesError":
          console.error('[GDX Webview] Domain values error:', message.error);
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
