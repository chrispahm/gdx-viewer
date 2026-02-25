import { useEffect, useState, useCallback, useRef } from "react";
import { DataTable } from "./components/DataTable";
import { SqlToolbar } from "./components/SqlToolbar";
import { LoadingOverlay } from "./components/LoadingOverlay";
import { type DisplayAttributes } from "./components/AttributesPanel";
import { wsClient } from "./wsClient";
import { buildSqlQuery } from "./lib/sqlBuilder";
import { useInfiniteData } from "./hooks/useInfiniteData";

// Re-export types from sqlBuilder for backward compatibility
export type {
  NumericFilterState,
  TextFilterState,
  FilterValue,
  ColumnFilter,
  ColumnSort,
} from "./lib/sqlBuilder";

import type { ColumnFilter, ColumnSort } from "./lib/sqlBuilder";

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

interface LocatorMessage {
  type: 'applyLocator';
  symbolName?: string;
  filters?: ColumnFilter[];
  targetColumn?: string;
  focusDimensions?: Record<string, string>;
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
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
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
  const filtersRef = useRef<ColumnFilter[]>([]);
  const sortsRef = useRef<ColumnSort[]>([]);
  const pendingLocatorDuringMaterializationRef = useRef<LocatorMessage | null>(null);
  const [materializedTableName, setMaterializedTableName] = useState<string | null>(null);
  const [highlightedRowKey, setHighlightedRowKey] = useState<string | null>(null);
  const [highlightedColumnName, setHighlightedColumnName] = useState<string | null>(null);
  const [scrollToRowIndex, setScrollToRowIndex] = useState<number | null>(null);
  const [materializationStatus, setMaterializationStatus] = useState<MaterializationStatus>('idle');
  const [materializationProgress, setMaterializationProgress] = useState<MaterializationProgress | null>(null);
  // Preview rows shown before materialization completes
  const [previewData, setPreviewData] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  // Track whether domain values are still being loaded
  const [domainValuesLoading, setDomainValuesLoading] = useState(false);

  // Infinite data hook — auto-fetches when enabled and tableName/filters/sorts change
  const infiniteData = useInfiniteData({
    tableName: materializedTableName,
    filters,
    sorts,
    totalRows,
    enabled: materializationStatus === 'materialized',
  });

  // Determine which data to show: preview rows or infinite data rows
  // Keep showing preview data until infinite data actually has rows, to prevent
  // filter components from unmounting during the preview→materialized transition.
  const isInPreviewMode = materializationStatus !== 'materialized' && materializationStatus !== 'idle';
  const useInfinite = materializationStatus === 'materialized' && infiniteData.rows.length > 0;
  const displayColumns = useInfinite
    ? (result?.columns ?? [])
    : (previewData ? previewData.columns : (result?.columns ?? []));
  const displayData = useInfinite
    ? infiniteData.rows
    : (previewData ? previewData.rows : infiniteData.rows);

  // Clear preview data once infinite data has loaded its first page
  useEffect(() => {
    if (materializationStatus === 'materialized' && infiniteData.rows.length > 0 && previewData) {
      setPreviewData(null);
    }
  }, [materializationStatus, infiniteData.rows.length, previewData]);

  // Run count query when filters are active
  const runCountQuery = useCallback(async (tableName: string, currentFilters: ColumnFilter[]) => {
    if (currentFilters.length === 0) return;

    const countSql = buildSqlQuery(tableName, currentFilters, [], 0, 0)
      .replace(/^SELECT \* FROM/, 'SELECT COUNT(*) as count FROM')
      .replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?$/i, '');

    const cachedCount = countCache.get(countSql);
    if (cachedCount !== undefined) {
      setTotalRows(cachedCount);
      return;
    }

    try {
      const countResult = await wsClient.request<QueryResult>("executeQuery", { sql: countSql });
      if (countResult.rows.length > 0 && countResult.rows[0].count !== undefined) {
        const count = typeof countResult.rows[0].count === 'bigint'
          ? Number(countResult.rows[0].count)
          : countResult.rows[0].count as number;
        setTotalRows(count);
        setCountCache(prev => {
          const updated = new Map(prev);
          updated.set(countSql, count);
          return updated;
        });
      }
    } catch (err) {
      console.error('[Count query error]', err);
    }
  }, [countCache]);

  // Execute query via WebSocket (for SQL toolbar manual queries)
  const executeQuery = useCallback(async (sql: string) => {
    if (!connected) {
      setError("Not connected to server");
      return;
    }
    setIsLoading(true);
    setError(null);

    await new Promise(resolve => setTimeout(resolve, 0));

    try {
      const queryResult = await wsClient.request<QueryResult>("executeQuery", { sql });
      setResult(queryResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query failed");
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }, [connected]);

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
        setPreviewData(null);
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

      if (!nextSymbol) {
        nextSymbol = nextSymbols[0];
        nextFilters = [];
        nextSorts = [];

        setFilters([]);
        setSorts([]);

        if (selectedSymbol) {
          setRefreshNotice(`Symbol '${selectedSymbol.name}' is no longer available. Showing '${nextSymbol.name}'.`);
        }
      }

      setSelectedSymbol(nextSymbol);
      setDomainValues(new Map());
      setDomainValuesLoading(true);
      setCountCache(new Map());
      setMaterializationStatus('idle');
      setMaterializationProgress(null);

      // Re-materialize the current symbol after force reload
      const mat = await wsClient.request<MaterializedSymbolResult>("materializeSymbol", {
        symbolName: nextSymbol.name,
      });

      if (mat.status === 'materialized') {
        setMaterializedTableName(mat.tableName);
        setTotalRows(mat.totalRowCount);
        setResult({ columns: mat.columns, rows: [], rowCount: mat.totalRowCount });
        setMaterializationStatus('materialized');
        // Hook auto-fetches when tableName changes + enabled becomes true
        // Also set filters/sorts so hook picks up correct state
        setFilters(nextFilters);
        setSorts(nextSorts);

        if (nextFilters.length > 0 && mat.tableName) {
          runCountQuery(mat.tableName, nextFilters);
        }
      } else {
        // Preview mode
        setMaterializedTableName(null);
        setTotalRows(mat.totalRowCount);
        setMaterializationStatus('preview');
        setPreviewData({
          columns: mat.columns,
          rows: mat.previewRows ?? [],
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
    runCountQuery,
  ]);

  const handleFiltersChange = useCallback(
    async (newFilters: ColumnFilter[]) => {
      if (!selectedSymbol) return;
      setFilters(newFilters);
      setScrollToRowIndex(null);
      // Hook auto-resets on filter change and fetches new data
      // Run count query for filtered totals
      if (materializedTableName && newFilters.length > 0) {
        runCountQuery(materializedTableName, newFilters);
      } else if (newFilters.length === 0) {
        // Restore unfiltered total from materialization
        setTotalRows(selectedSymbol.recordCount);
        setCountCache(new Map());
      }
    },
    [selectedSymbol, materializedTableName, runCountQuery]
  );

  const handleSortsChange = useCallback(
    (newSorts: ColumnSort[]) => {
      if (!selectedSymbol) return;
      setSorts(newSorts);
      setScrollToRowIndex(null);
      // Hook auto-resets on sort change
    },
    [selectedSymbol]
  );

  const handleResetFilters = useCallback(
    () => {
      if (!selectedSymbol) return;
      setFilters([]);
      setSorts([]);
      setScrollToRowIndex(null);
      setCountCache(new Map());
      // Restore unfiltered total
      setTotalRows(selectedSymbol.recordCount);
      // Hook auto-resets
    },
    [selectedSymbol]
  );

  const handleSymbolSelect = useCallback(
    async (symbol: GdxSymbol) => {
      setSelectedSymbol(symbol);
      setFilters([]);
      setSorts([]);
      setDomainValues(new Map());
      setCountCache(new Map());
      setHighlightedRowKey(null);
      setHighlightedColumnName(null);
      setScrollToRowIndex(null);
      setMaterializationStatus('idle');
      setMaterializationProgress(null);
      setPreviewData(null);
      setDomainValuesLoading(true);
      setIsLoading(true);
      setError(null);

      vscode.postMessage({ type: "selectSymbol", symbol });

      try {
        const mat = await wsClient.request<MaterializedSymbolResult>("materializeSymbol", {
          symbolName: symbol.name,
        });

        if (mat.status === 'materialized') {
          // Already cached — set table name, hook will auto-fetch
          setMaterializedTableName(mat.tableName);
          setTotalRows(mat.totalRowCount);
          setResult({ columns: mat.columns, rows: [], rowCount: mat.totalRowCount });
          setMaterializationStatus('materialized');
          setQuery(`SELECT * FROM "${mat.tableName}"`);
        } else {
          // Preview mode — show preview rows immediately
          setMaterializedTableName(null);
          setTotalRows(mat.totalRowCount);
          setMaterializationStatus('preview');
          setPreviewData({
            columns: mat.columns,
            rows: mat.previewRows ?? [],
          });
          setQuery(`-- Preview (first ${mat.previewRowCount} rows)`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Query failed");
        setResult(null);
        setPreviewData(null);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const handleExport = useCallback(
    async (format: 'csv' | 'parquet' | 'excel') => {
      if (!query || !selectedSymbol) return;
      setIsExporting(true);
      setError(null);
      try {
        vscode.postMessage({ type: 'exportData', format, query });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Export failed');
      } finally {
        setIsExporting(false);
      }
    },
    [query, selectedSymbol]
  );

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
    setDomainValues(new Map());
    setDomainValuesLoading(true);
    setCountCache(new Map());
    setHighlightedColumnName(locator.targetColumn?.trim() || null);

    // Materialize if needed
    const mat = await wsClient.request<MaterializedSymbolResult>("materializeSymbol", {
      symbolName: symbol.name,
    });

    if (mat.status !== 'materialized') {
      // Preview — queue the locator for when materialization completes
      setMaterializedTableName(null);
      setTotalRows(mat.totalRowCount);
      setMaterializationStatus('preview');
      setPreviewData({
        columns: mat.columns,
        rows: mat.previewRows ?? [],
      });

      pendingLocatorDuringMaterializationRef.current = locator;
      return;
    }

    setMaterializedTableName(mat.tableName);
    setTotalRows(mat.totalRowCount);
    setResult({ columns: mat.columns, rows: [], rowCount: mat.totalRowCount });
    setMaterializationStatus('materialized');

    // Run count query for locator filters
    if (mat.tableName && locatorFilters.length > 0) {
      runCountQuery(mat.tableName, locatorFilters);
    }

    // The hook will auto-fetch data with the new filters.
    // We need to find the target row after data loads.
    // Since the hook is async, we'll use a small delay to let it populate.
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

    // Fetch the first page directly for locator highlighting
    const sql = buildSqlQuery(mat.tableName!, locatorFilters, [], 5000, 0);
    try {
      const queryResult = await wsClient.request<QueryResult>("executeQuery", { sql });

      if (targetDimensionEntries.length === 0) {
        if (queryResult.rows.length === 1) {
          const inferredKey = buildDimensionRowKey(queryResult.rows[0], symbol.dimensionCount);
          setHighlightedRowKey(inferredKey);
          setScrollToRowIndex(0);
        } else {
          setHighlightedRowKey(null);
        }
        return;
      }

      const matchedIndex = queryResult.rows.findIndex(row =>
        targetDimensionEntries.every(([column, value]) => String(row[column] ?? '') === value)
      );

      if (matchedIndex >= 0) {
        setHighlightedRowKey(buildDimensionRowKey(queryResult.rows[matchedIndex], symbol.dimensionCount));
        setScrollToRowIndex(matchedIndex);
      } else {
        setHighlightedRowKey(null);
        setRefreshNotice('No exact match found for the requested location with current filters.');
      }
    } catch (err) {
      console.error('[applyLocator query error]', err);
      setHighlightedRowKey(null);
    }
  }, [symbols, selectedSymbol, runCountQuery]);

  const handleSymbolSelectRef = useRef(handleSymbolSelect);
  const refreshCurrentDocumentRef = useRef(refreshCurrentDocument);
  const applyLocatorRef = useRef(applyLocator);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => { selectedSymbolRef.current = selectedSymbol; }, [selectedSymbol]);
  useEffect(() => { filtersRef.current = filters; }, [filters]);
  useEffect(() => { sortsRef.current = sorts; }, [sorts]);

  useEffect(() => {
    handleSymbolSelectRef.current = handleSymbolSelect;
    refreshCurrentDocumentRef.current = refreshCurrentDocument;
    applyLocatorRef.current = applyLocator;
  }, [handleSymbolSelect, refreshCurrentDocument, applyLocator]);

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
      setMaterializationProgress(null);

      const currentSymbol = selectedSymbolRef.current;
      if (currentSymbol && currentSymbol.name === d.symbolName) {
        // Set table name — this triggers the hook to auto-fetch first page
        setMaterializedTableName(d.tableName);
        setTotalRows(d.totalRowCount);
        setResult({ columns: d.columns, rows: [], rowCount: d.totalRowCount });
        setMaterializationStatus('materialized');
        // Don't clear previewData here — keep it visible until infiniteData has rows
        setQuery(`SELECT * FROM "${d.tableName}"`);

        // Run count query if filters are active
        const currentFilters = filtersRef.current;
        if (currentFilters.length > 0) {
          const countSql = buildSqlQuery(d.tableName, currentFilters, [], 0, 0)
            .replace(/^SELECT \* FROM/, 'SELECT COUNT(*) as count FROM')
            .replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?$/i, '');
          try {
            const countResult = await wsClient.request<QueryResult>("executeQuery", { sql: countSql });
            if (countResult.rows.length > 0 && countResult.rows[0].count !== undefined) {
              const count = typeof countResult.rows[0].count === 'bigint'
                ? Number(countResult.rows[0].count)
                : countResult.rows[0].count as number;
              setTotalRows(count);
            }
          } catch (err) {
            console.error('[materializationComplete count query error]', err);
          }
        }

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

    const unsubDomainValues = wsClient.on('domainValuesReady', (data: unknown) => {
      const d = data as { symbolName: string; domainValues: Record<string, string[]> };
      const currentSymbol = selectedSymbolRef.current;
      if (currentSymbol && currentSymbol.name === d.symbolName) {
        setDomainValues(new Map(Object.entries(d.domainValues)));
        setDomainValuesLoading(false);
      }
    });

    const unsubError = wsClient.on('materializationError', (data: unknown) => {
      const d = data as { cancelled: boolean; error?: string; symbolName: string };
      if (d.cancelled) {
        return;
      }
      setMaterializationProgress(null);
      setMaterializationStatus('preview');
      setRefreshNotice(`Materialization failed: ${d.error ?? 'Unknown error'}. Preview data is still shown.`);
    });

    return () => {
      unsubProgress();
      unsubComplete();
      unsubDomainValues();
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

          try {
            await wsClient.connect(message.serverPort);
            wsClient.setDocumentId(message.documentId);
            setConnected(true);
            initializedDocumentIdRef.current = message.documentId;
            setDocumentSource({ filePath: message.filePath, documentId: message.documentId });

            const initResult = await wsClient.request<{ symbols: GdxSymbol[] }>("openDocument", {
              filePath: message.filePath,
              documentId: message.documentId,
            });

            const syms = initResult.symbols;
            setSymbols(syms);
            vscode.postMessage({ type: "symbolsLoaded", symbols: syms });

            if (syms.length > 0) {
              const firstSymbol = syms[0];
              setSelectedSymbol(firstSymbol);

              setIsLoading(true);
              try {
                const mat = await wsClient.request<MaterializedSymbolResult>("materializeSymbol", {
                  symbolName: firstSymbol.name,
                });

                if (mat.status === 'materialized') {
                  setMaterializedTableName(mat.tableName);
                  setTotalRows(mat.totalRowCount);
                  setResult({ columns: mat.columns, rows: [], rowCount: mat.totalRowCount });
                  setMaterializationStatus('materialized');
                  setQuery(`SELECT * FROM "${mat.tableName}"`);
                  // Hook auto-fetches first page; domain values arrive via event
                } else {
                  setMaterializedTableName(null);
                  setTotalRows(mat.totalRowCount);
                  setMaterializationStatus('preview');
                  setPreviewData({
                    columns: mat.columns,
                    rows: mat.previewRows ?? [],
                  });
                  setQuery(`-- Preview (first ${mat.previewRowCount} rows)`);
                }

                if (pendingLocatorRef.current) {
                  const pending = pendingLocatorRef.current;
                  pendingLocatorRef.current = null;
                  if (mat.status === 'materialized') {
                    await applyLocator(pending, syms, firstSymbol);
                  } else {
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

  // Determine if we have any data to show
  const hasData = displayColumns.length > 0 && (displayData.length > 0 || infiniteData.isLoading || isLoading);

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
        {(hasData || (displayColumns.length > 0 && displayData.length === 0)) ? (
          <DataTable
            columns={displayColumns}
            data={displayData}
            totalRows={totalRows}
            hasNextPage={!isInPreviewMode && infiniteData.hasNextPage}
            isFetchingMore={infiniteData.isFetchingMore}
            onFetchMore={infiniteData.fetchNextPage}
            scrollToRowIndex={scrollToRowIndex}
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
            domainValuesLoading={domainValuesLoading}
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
          isLoading={isLoading || infiniteData.isLoading}
          isRefreshing={isRefreshing}
          materializationStatus={materializationStatus}
          materializationProgress={materializationProgress}
          onCancelMaterialization={handleCancelMaterialization}
        />
      </div>
    </div>
  );
}
