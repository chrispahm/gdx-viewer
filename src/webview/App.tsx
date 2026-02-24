import { useEffect, useState, useCallback, useRef } from "react";
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

interface LocatorMessage {
  type: 'applyLocator';
  symbolName?: string;
  filters?: ColumnFilter[];
  targetColumn?: string;
  focusDimensions?: Record<string, string>;
}

// Helper to check if a filter is numeric
function isNumericFilter(filter: FilterValue): filter is NumericFilterState {
  return 'exclude' in filter;
}

type MaterializationStatus = 'idle' | 'preview' | 'materializing' | 'materialized';

interface MaterializationProgress {
  percentage: number;
  rowsProcessed: number;
  totalRows: number;
}

interface MaterializedSymbolResult {
  tableName: string | null;
  columns: string[];
  totalRowCount: number;
  status: 'preview' | 'materialized';
  previewRows?: Record<string, unknown>[];
  previewRowCount?: number;
}

// SQL Builder function — queries materialized table by name
function buildSqlQuery(
  tableName: string,
  filters: ColumnFilter[],
  sorts: ColumnSort[],
  pageSize: number,
  pageIndex: number
): string {
  let sql = `SELECT * FROM "${tableName}"`;

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

function buildDimensionRowKey(row: Record<string, unknown>, dimensionCount: number): string | null {
  if (dimensionCount <= 0) {
    return null;
  }

  const parts: string[] = [];
  for (let dim = 1; dim <= dimensionCount; dim++) {
    const column = `dim_${dim}`;
    const value = row[column];
    if (value === undefined || value === null) {
      return null;
    }
    parts.push(`${column}=${String(value)}`);
  }
  return parts.join('|');
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFilterLoading, setIsFilterLoading] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(1000);
  const [totalRows, setTotalRows] = useState(0);
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [sorts, setSorts] = useState<ColumnSort[]>([]);
  const [domainValues, setDomainValues] = useState<Map<string, string[]>>(new Map());
  const [connected, setConnected] = useState(false);
  // Cache for count queries keyed by SQL string - avoids redundant expensive COUNT queries
  const [countCache, setCountCache] = useState<Map<string, number>>(new Map());
  const [documentSource, setDocumentSource] = useState<{ filePath: string; documentId: string } | null>(null);
  const [displayAttributes, setDisplayAttributes] = useState<DisplayAttributes>({
    squeezeDefaults: true,
    squeezeTrailingZeroes: false,
    format: 'g-format',
    precision: 6,
  });
  const initializedDocumentIdRef = useRef<string | null>(null);
  const connectedRef = useRef(false);
  const pendingLocatorRef = useRef<LocatorMessage | null>(null);
  const selectedSymbolRef = useRef<GdxSymbol | null>(null);
  const pageIndexRef = useRef(0);
  const pageSizeRef = useRef(1000);
  const filtersRef = useRef<ColumnFilter[]>([]);
  const sortsRef = useRef<ColumnSort[]>([]);
  const pendingLocatorDuringMaterializationRef = useRef<LocatorMessage | null>(null);
  const [materializedTableName, setMaterializedTableName] = useState<string | null>(null);
  const [highlightedRowKey, setHighlightedRowKey] = useState<string | null>(null);
  const [highlightedColumnName, setHighlightedColumnName] = useState<string | null>(null);
  const [materializationStatus, setMaterializationStatus] = useState<MaterializationStatus>('idle');
  const [materializationProgress, setMaterializationProgress] = useState<MaterializationProgress | null>(null);

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
    async (
      symbol: GdxSymbol,
      newPageIndex: number,
      newPageSize: number,
      newFilters: ColumnFilter[],
      newSorts: ColumnSort[],
      options?: { background?: boolean; tableName?: string }
    ): Promise<QueryResult | null> => {
      const isBackgroundRefresh = options?.background ?? false;
      const tableNameToUse = options?.tableName ?? materializedTableName;

      if (!tableNameToUse) {
        setError("Symbol not materialized");
        return null;
      }

      // Set loading state first
      if (!isBackgroundRefresh) {
        setIsLoading(true);
      }
      setError(null);

      // Use setTimeout to let React render the loading state before doing any work
      await new Promise(resolve => setTimeout(resolve, 0));

      // Build the query for data
      const sql = buildSqlQuery(tableNameToUse, newFilters, newSorts, newPageSize, newPageIndex);
      setQuery(sql);

      try {
        // Execute data query
        const dataResult = await wsClient.request<QueryResult>("executeQuery", { sql });
        setResult(dataResult);
        if (!isBackgroundRefresh) {
          setIsLoading(false);
        }

        // Only run count query if there are active filters
        // Without filters, we use totalRowCount from materialization
        if (newFilters.length > 0) {
          // Build count query (without ORDER BY, LIMIT, OFFSET since those don't affect count)
          const countSql = buildSqlQuery(tableNameToUse, newFilters, [], 0, 0)
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
        }

        return dataResult;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Query failed");
        if (!isBackgroundRefresh) {
          setResult(null);
          setIsLoading(false);
        }

        return null;
      }
    },
    [countCache, materializedTableName]
  );

  const loadFilterOptions = useCallback(async (symbolName: string, currentFilters: ColumnFilter[]) => {
    setIsFilterLoading(true);
    try {
      const result = await wsClient.request<{ filterOptions: Record<string, string[]> }>("getFilterOptions", {
        symbolName,
        filters: currentFilters,
      });
      setDomainValues(new Map(Object.entries(result.filterOptions)));
    } catch (err) {
      console.error('[loadFilterOptions error]', err);
    } finally {
      setIsFilterLoading(false);
    }
  }, []);

  const refreshCurrentDocument = useCallback(async () => {
    if (!connected || !documentSource) {
      return;
    }

    setIsRefreshing(true);
    setRefreshNotice(null);
    setError(null);

    try {
      const refreshed = await wsClient.request<{ symbols: GdxSymbol[] }>("openDocument", {
        filePath: documentSource.filePath,
        documentId: documentSource.documentId,
        forceReload: true,
      });

      const nextSymbols = refreshed.symbols;
      console.log(`[GDX] Refreshed document ${documentSource.filePath}: ${nextSymbols.length} symbols`);
      setSymbols(nextSymbols);
      vscode.postMessage({ type: "symbolsLoaded", symbols: nextSymbols });

      if (nextSymbols.length === 0) {
        setSelectedSymbol(null);
        setMaterializedTableName(null);
        setResult(null);
        setTotalRows(0);
        setDomainValues(new Map());
        setCountCache(new Map());
        setRefreshNotice("Source updated, but no symbols are available.");
        return;
      }

      let nextSymbol = selectedSymbol
        ? nextSymbols.find(symbol => symbol.name === selectedSymbol.name) ?? null
        : null;

      let nextFilters = filters;
      let nextSorts = sorts;
      let nextPageIndex = pageIndex;

      if (!nextSymbol) {
        nextSymbol = nextSymbols[0];
        nextFilters = [];
        nextSorts = [];
        nextPageIndex = 0;

        setFilters([]);
        setSorts([]);
        setPageIndex(0);

        if (selectedSymbol) {
          setRefreshNotice(`Symbol '${selectedSymbol.name}' is no longer available. Showing '${nextSymbol.name}'.`);
        }
      }

      setSelectedSymbol(nextSymbol);
      setDomainValues(new Map());
      setCountCache(new Map());
      setMaterializationStatus('idle');
      setMaterializationProgress(null);

      // Re-materialize the current symbol after force reload
      const mat = await wsClient.request<MaterializedSymbolResult>("materializeSymbol", {
        symbolName: nextSymbol.name,
        pageSize,
      });

      if (mat.status === 'materialized') {
        setMaterializedTableName(mat.tableName);
        setTotalRows(mat.totalRowCount);
        setMaterializationStatus('materialized');

        await executeQueryWithFiltersAndSorts(
          nextSymbol,
          nextPageIndex,
          pageSize,
          nextFilters,
          nextSorts,
          { background: true, tableName: mat.tableName! }
        );

        loadFilterOptions(nextSymbol.name, nextFilters);
      } else {
        // Preview mode
        setMaterializedTableName(null);
        setTotalRows(mat.totalRowCount);
        setMaterializationStatus('preview');
        setResult({
          columns: mat.columns,
          rows: mat.previewRows ?? [],
          rowCount: mat.previewRowCount ?? 0,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh document");
    } finally {
      setIsRefreshing(false);
    }
  }, [
    connected,
    documentSource,
    selectedSymbol,
    filters,
    sorts,
    pageIndex,
    pageSize,
    executeQueryWithFiltersAndSorts,
    loadFilterOptions,
  ]);

  const handleFiltersChange = useCallback(
    async (newFilters: ColumnFilter[]) => {
      if (!selectedSymbol) return;
      setFilters(newFilters);
      setPageIndex(0); // Reset to first page when filters change
      await executeQueryWithFiltersAndSorts(selectedSymbol, 0, pageSize, newFilters, sorts);
      // Cross-filtering: update dimension dropdowns based on new filters
      loadFilterOptions(selectedSymbol.name, newFilters);
    },
    [selectedSymbol, pageSize, sorts, executeQueryWithFiltersAndSorts, loadFilterOptions]
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
      // Reload filter options with no filters
      loadFilterOptions(selectedSymbol.name, []);
    },
    [selectedSymbol, pageSize, executeQueryWithFiltersAndSorts, loadFilterOptions]
  );

  const handleSymbolSelect = useCallback(
    async (symbol: GdxSymbol) => {
      setSelectedSymbol(symbol);
      setPageIndex(0);
      setFilters([]);
      setSorts([]);
      setDomainValues(new Map());
      setCountCache(new Map());
      setHighlightedRowKey(null);
      setHighlightedColumnName(null);
      setMaterializationStatus('idle');
      setMaterializationProgress(null);
      setIsLoading(true);
      setError(null);

      vscode.postMessage({ type: "selectSymbol", symbol });

      try {
        const mat = await wsClient.request<MaterializedSymbolResult>("materializeSymbol", {
          symbolName: symbol.name,
          pageSize,
        });

        if (mat.status === 'materialized') {
          // Already cached — full flow
          setMaterializedTableName(mat.tableName);
          setTotalRows(mat.totalRowCount);
          setMaterializationStatus('materialized');

          const sql = buildSqlQuery(mat.tableName!, [], [], pageSize, 0);
          setQuery(sql);
          const queryResult = await wsClient.request<QueryResult>("executeQuery", { sql });
          setResult(queryResult);

          loadFilterOptions(symbol.name, []);
        } else {
          // Preview mode — show preview rows immediately
          setMaterializedTableName(null);
          setTotalRows(mat.totalRowCount);
          setMaterializationStatus('preview');
          setResult({
            columns: mat.columns,
            rows: mat.previewRows ?? [],
            rowCount: mat.previewRowCount ?? 0,
          });
          setQuery(`-- Preview (first ${mat.previewRowCount} rows)`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Query failed");
        setResult(null);
      } finally {
        setIsLoading(false);
      }
    },
    [pageSize, loadFilterOptions]
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

  const handleCancelMaterialization = useCallback(async () => {
    try {
      await wsClient.request("cancelMaterialization", {});
    } catch (err) {
      console.error('[cancelMaterialization error]', err);
    }
    setMaterializationStatus(prev => prev === 'idle' || prev === 'materialized' ? prev : 'preview');
    setMaterializationProgress(null);
  }, []);

  const applyLocator = useCallback(async (
    locator: LocatorMessage,
    availableSymbols: GdxSymbol[] = symbols,
    currentSelectedSymbol: GdxSymbol | null = selectedSymbol
  ) => {
    if (!connectedRef.current) {
      setRefreshNotice("Waiting for server connection before revealing location.");
      pendingLocatorRef.current = locator;
      return;
    }

    if (availableSymbols.length === 0 && !currentSelectedSymbol) {
      pendingLocatorRef.current = locator;
      return;
    }

    const symbolName = locator.symbolName?.trim();
    const symbol = symbolName
      ? availableSymbols.find(candidate => candidate.name === symbolName)
      : currentSelectedSymbol;

    if (!symbol) {
      setRefreshNotice(symbolName
        ? `Symbol '${symbolName}' not found in this document.`
        : "No symbol selected to reveal location.");
      return;
    }

    const locatorFilters = locator.filters ?? [];
    setRefreshNotice(null);
    setSelectedSymbol(symbol);
    setFilters(locatorFilters);
    setSorts([]);
    setPageIndex(0);
    setDomainValues(new Map());
    setCountCache(new Map());
    setHighlightedColumnName(locator.targetColumn?.trim() || null);

    // Materialize if needed
    const mat = await wsClient.request<MaterializedSymbolResult>("materializeSymbol", {
      symbolName: symbol.name,
      pageSize,
    });

    if (mat.status !== 'materialized') {
      // Preview — queue the locator for when materialization completes
      setMaterializedTableName(null);
      setTotalRows(mat.totalRowCount);
      setMaterializationStatus('preview');
      setResult({
        columns: mat.columns,
        rows: mat.previewRows ?? [],
        rowCount: mat.previewRowCount ?? 0,
      });

      // Store locator with filters to apply after materialization
      pendingLocatorDuringMaterializationRef.current = locator;
      return;
    }

    setMaterializedTableName(mat.tableName);
    setTotalRows(mat.totalRowCount);
    setMaterializationStatus('materialized');

    const queryResult = await executeQueryWithFiltersAndSorts(symbol, 0, pageSize, locatorFilters, [], { tableName: mat.tableName! });
    loadFilterOptionsRef.current(symbol.name, locatorFilters);

    const targetDimensions = locator.focusDimensions ?? Object.fromEntries(
      locatorFilters
        .filter(filter => /^dim_\d+$/i.test(filter.columnName))
        .map(filter => {
          const selectedValues = 'selectedValues' in filter.filterValue
            ? filter.filterValue.selectedValues
            : [];
          return [filter.columnName, selectedValues.length === 1 ? selectedValues[0] : ''];
        })
        .filter((entry): entry is [string, string] => entry[1].length > 0)
    );

    const targetDimensionEntries = Object.keys(targetDimensions).length > 0
      ? Object.entries(targetDimensions)
        .sort(([left], [right]) => {
          const leftMatch = left.match(/^dim_(\d+)$/i);
          const rightMatch = right.match(/^dim_(\d+)$/i);
          if (leftMatch && rightMatch) {
            return Number(leftMatch[1]) - Number(rightMatch[1]);
          }
          return left.localeCompare(right);
        })
      : [];

    if (!queryResult) {
      setHighlightedRowKey(null);
      return;
    }

    if (targetDimensionEntries.length === 0) {
      if (queryResult.rows.length === 1) {
        const inferredKey = buildDimensionRowKey(queryResult.rows[0], symbol.dimensionCount);
        setHighlightedRowKey(inferredKey);
      } else {
        setHighlightedRowKey(null);
      }
      return;
    }

    const matchedRow = queryResult.rows.find(row =>
      targetDimensionEntries.every(([column, value]) => String(row[column] ?? '') === value)
    );

    if (matchedRow) {
      setHighlightedRowKey(buildDimensionRowKey(matchedRow, symbol.dimensionCount));
    } else {
      setHighlightedRowKey(null);
      setRefreshNotice('No exact match found for the requested location with current filters.');
    }
  }, [symbols, selectedSymbol, executeQueryWithFiltersAndSorts, pageSize]);

  const loadFilterOptionsRef = useRef(loadFilterOptions);
  const handleSymbolSelectRef = useRef(handleSymbolSelect);
  const refreshCurrentDocumentRef = useRef(refreshCurrentDocument);
  const applyLocatorRef = useRef(applyLocator);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => { selectedSymbolRef.current = selectedSymbol; }, [selectedSymbol]);
  useEffect(() => { pageIndexRef.current = pageIndex; }, [pageIndex]);
  useEffect(() => { pageSizeRef.current = pageSize; }, [pageSize]);
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  useEffect(() => { sortsRef.current = sorts; }, [sorts]);

  useEffect(() => {
    loadFilterOptionsRef.current = loadFilterOptions;
    handleSymbolSelectRef.current = handleSymbolSelect;
    refreshCurrentDocumentRef.current = refreshCurrentDocument;
    applyLocatorRef.current = applyLocator;
  }, [loadFilterOptions, handleSymbolSelect, refreshCurrentDocument, applyLocator]);

  // WebSocket event listeners for background materialization
  useEffect(() => {
    const unsubProgress = wsClient.on('materializationProgress', (data: unknown) => {
      const d = data as { percentage: number; rowsProcessed: number; totalRows: number };
      setMaterializationProgress({
        percentage: d.percentage,
        rowsProcessed: d.rowsProcessed,
        totalRows: d.totalRows,
      });
      setMaterializationStatus(prev => prev === 'preview' || prev === 'materializing' ? 'materializing' : prev);
    });

    const unsubComplete = wsClient.on('materializationComplete', async (data: unknown) => {
      const d = data as { tableName: string; columns: string[]; totalRowCount: number; symbolName: string };
      setMaterializedTableName(d.tableName);
      setTotalRows(d.totalRowCount);
      setMaterializationStatus('materialized');
      setMaterializationProgress(null);

      // Re-fetch the current page from the materialized table
      const currentSymbol = selectedSymbolRef.current;
      if (currentSymbol && currentSymbol.name === d.symbolName) {
        const currentFilters = filtersRef.current;
        const currentSorts = sortsRef.current;
        const currentPageIndex = pageIndexRef.current;
        const currentPageSize = pageSizeRef.current;

        const sql = buildSqlQuery(d.tableName, currentFilters, currentSorts, currentPageSize, currentPageIndex);
        setQuery(sql);
        try {
          const queryResult = await wsClient.request<QueryResult>("executeQuery", { sql });
          setResult(queryResult);
        } catch (err) {
          console.error('[materializationComplete re-fetch error]', err);
        }

        // Load filter options now that table is materialized
        loadFilterOptionsRef.current(d.symbolName, currentFilters);

        // Apply any pending locator that was queued during materialization
        const pendingLocator = pendingLocatorDuringMaterializationRef.current;
        if (pendingLocator) {
          pendingLocatorDuringMaterializationRef.current = null;
          setTimeout(() => {
            applyLocatorRef.current(pendingLocator);
          }, 0);
        }
      }
    });

    const unsubError = wsClient.on('materializationError', (data: unknown) => {
      const d = data as { cancelled: boolean; error?: string; symbolName: string };
      if (d.cancelled) {
        // Cancelled — keep preview data visible, don't change status
        return;
      }
      // Real error — show notice but keep preview data visible
      setMaterializationProgress(null);
      setMaterializationStatus('preview');
      setRefreshNotice(`Materialization failed: ${d.error ?? 'Unknown error'}. Preview data is still shown.`);
    });

    return () => {
      unsubProgress();
      unsubComplete();
      unsubError();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle messages from extension
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const message = event.data;

      switch (message.type) {
        case "init":
          if (initializedDocumentIdRef.current === message.documentId && connectedRef.current) {
            return;
          }

          // Connect to WebSocket server
          try {
            await wsClient.connect(message.serverPort);
            wsClient.setDocumentId(message.documentId);
            setConnected(true);
            initializedDocumentIdRef.current = message.documentId;
            setDocumentSource({ filePath: message.filePath, documentId: message.documentId });

            // Open document on server
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

              setIsLoading(true);
              try {
                const mat = await wsClient.request<MaterializedSymbolResult>("materializeSymbol", {
                  symbolName: firstSymbol.name,
                  pageSize: 1000,
                });

                if (mat.status === 'materialized') {
                  setMaterializedTableName(mat.tableName);
                  setTotalRows(mat.totalRowCount);
                  setMaterializationStatus('materialized');

                  const sql = buildSqlQuery(mat.tableName!, [], [], 1000, 0);
                  setQuery(sql);
                  const queryResult = await wsClient.request<QueryResult>("executeQuery", { sql });
                  setResult(queryResult);

                  loadFilterOptionsRef.current(firstSymbol.name, []);
                } else {
                  // Preview mode
                  setMaterializedTableName(null);
                  setTotalRows(mat.totalRowCount);
                  setMaterializationStatus('preview');
                  setResult({
                    columns: mat.columns,
                    rows: mat.previewRows ?? [],
                    rowCount: mat.previewRowCount ?? 0,
                  });
                  setQuery(`-- Preview (first ${mat.previewRowCount} rows)`);
                }

                if (pendingLocatorRef.current) {
                  const pending = pendingLocatorRef.current;
                  pendingLocatorRef.current = null;
                  if (mat.status === 'materialized') {
                    await applyLocator(pending, syms, firstSymbol);
                  } else {
                    // Queue for after materialization completes
                    pendingLocatorDuringMaterializationRef.current = pending;
                  }
                }
              } catch (err) {
                setError(err instanceof Error ? err.message : "Query failed");
              } finally {
                setIsLoading(false);
              }
            }
          } catch (err) {
            initializedDocumentIdRef.current = null;
            setError(err instanceof Error ? err.message : "Failed to connect to server");
          }
          break;

        case "selectSymbol":
          handleSymbolSelectRef.current(message.symbol);
          break;

        case "gdxFileChanged":
          refreshCurrentDocumentRef.current();
          break;

        case "exportPath":
          // Extension provided export path, execute export on server
          // TODO: Implement export via WebSocket
          break;

        case "applyLocator": {
          const locator = message as LocatorMessage;
          await applyLocator(locator);
          break;
        }
      }
    };

    window.addEventListener("message", handleMessage);
    vscode.postMessage({ type: "ready" });

    return () => window.removeEventListener("message", handleMessage);
  }, [applyLocator]);

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
        isRefreshing={isRefreshing}
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

      {refreshNotice && (
        <div style={{
          padding: '8px 12px',
          backgroundColor: 'var(--vscode-editorInfo-background)',
          color: 'var(--vscode-editorInfo-foreground)',
          borderBottom: '1px solid var(--vscode-panel-border, transparent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px'
        }}>
          <span>{refreshNotice}</span>
          <button
            onClick={() => setRefreshNotice(null)}
            style={{
              padding: '2px 8px',
              backgroundColor: 'transparent',
              color: 'var(--vscode-editorInfo-foreground)',
              border: 'none',
              borderRadius: '3px',
              cursor: 'pointer',
              fontFamily: 'var(--vscode-font-family)',
              fontSize: 'var(--vscode-font-size)',
            }}
          >
            Dismiss
          </button>
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
            highlightedRowKey={highlightedRowKey}
            highlightedColumnName={highlightedColumnName}
            isMaterialized={materializationStatus === 'materialized'}
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
          isRefreshing={isRefreshing}
          onCancelFilterLoading={handleCancelFilterLoading}
          materializationStatus={materializationStatus}
          materializationProgress={materializationProgress}
          onCancelMaterialization={handleCancelMaterialization}
        />
      </div>
    </div>
  );
}
