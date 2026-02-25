import { useState, useCallback, useRef, useEffect } from "react";
import { wsClient } from "../wsClient";
import { buildSqlQuery } from "../lib/sqlBuilder";
import type { ColumnFilter, ColumnSort } from "../lib/sqlBuilder";

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface UseInfiniteDataOptions {
  tableName: string | null;
  filters: ColumnFilter[];
  sorts: ColumnSort[];
  totalRows: number;
  enabled: boolean;
  fetchSize?: number;
}

export interface UseInfiniteDataReturn {
  rows: Record<string, unknown>[];
  isLoading: boolean;
  isFetchingMore: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => void;
  reset: () => void;
}

export function useInfiniteData({
  tableName,
  filters,
  sorts,
  totalRows,
  enabled,
  fetchSize = 2000,
}: UseInfiniteDataOptions): UseInfiniteDataReturn {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);

  const isFetchingRef = useRef(false);
  const generationRef = useRef(0);
  const offsetRef = useRef(0);

  // Track previous deps to detect changes
  const prevTableNameRef = useRef(tableName);
  const prevFiltersRef = useRef(filters);
  const prevSortsRef = useRef(sorts);
  const prevEnabledRef = useRef(enabled);

  const hasNextPage = rows.length < totalRows;

  const fetchPage = useCallback(async (offset: number, generation: number, isFirstPage: boolean) => {
    if (!tableName || isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;
    if (isFirstPage) {
      setIsLoading(true);
    } else {
      setIsFetchingMore(true);
    }

    try {
      const sql = buildSqlQuery(tableName, filters, sorts, fetchSize, offset);
      const result = await wsClient.request<QueryResult>("executeQuery", { sql });

      // Stale response check
      if (generation !== generationRef.current) {
        return;
      }

      if (isFirstPage) {
        setRows(result.rows);
      } else {
        setRows(prev => [...prev, ...result.rows]);
      }
      offsetRef.current = offset + result.rows.length;
    } catch (err) {
      // Only log if not stale
      if (generation === generationRef.current) {
        console.error('[useInfiniteData] fetch error:', err);
      }
    } finally {
      isFetchingRef.current = false;
      if (isFirstPage) {
        setIsLoading(false);
      } else {
        setIsFetchingMore(false);
      }
    }
  }, [tableName, filters, sorts, fetchSize]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    offsetRef.current = 0;
    isFetchingRef.current = false;
    setRows([]);
    setIsLoading(false);
    setIsFetchingMore(false);
  }, []);

  const fetchNextPage = useCallback(() => {
    if (!enabled || !hasNextPage || isFetchingRef.current) {
      return;
    }
    fetchPage(offsetRef.current, generationRef.current, false);
  }, [enabled, hasNextPage, fetchPage]);

  // Auto-reset and re-fetch when deps change
  useEffect(() => {
    const tableNameChanged = prevTableNameRef.current !== tableName;
    const filtersChanged = prevFiltersRef.current !== filters;
    const sortsChanged = prevSortsRef.current !== sorts;
    const enabledChanged = prevEnabledRef.current !== enabled;

    prevTableNameRef.current = tableName;
    prevFiltersRef.current = filters;
    prevSortsRef.current = sorts;
    prevEnabledRef.current = enabled;

    if (!enabled || !tableName) {
      if (tableNameChanged || !enabled) {
        reset();
      }
      return;
    }

    if (tableNameChanged || filtersChanged || sortsChanged || enabledChanged) {
      // Reset and fetch first page
      generationRef.current += 1;
      offsetRef.current = 0;
      isFetchingRef.current = false;
      setRows([]);
      const gen = generationRef.current;

      // Small delay to let React render the cleared state
      fetchPage(0, gen, true);
    }
  }, [tableName, filters, sorts, enabled, reset, fetchPage]);

  return {
    rows,
    isLoading,
    isFetchingMore,
    hasNextPage,
    fetchNextPage,
    reset,
  };
}
