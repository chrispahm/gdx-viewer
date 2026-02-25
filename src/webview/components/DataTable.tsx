import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { NumericFilter, type NumericFilterState } from "./NumericFilter";
import { TextFilter } from "./TextFilter";
import type { DisplayAttributes } from "./AttributesPanel";
import type { ColumnFilter, ColumnSort } from "../lib/sqlBuilder";

interface DataTableProps {
  columns: string[];
  data: Record<string, unknown>[];
  totalRows: number;
  hasNextPage: boolean;
  isFetchingMore: boolean;
  onFetchMore: () => void;
  scrollToRowIndex?: number | null;
  displayAttributes: DisplayAttributes;
  filters: ColumnFilter[];
  sorts: ColumnSort[];
  onFiltersChange: (filters: ColumnFilter[]) => void;
  onSortsChange: (sorts: ColumnSort[]) => void;
  domainValues: Map<string, string[]>;
  dimensionCount: number;
  highlightedRowKey?: string | null;
  highlightedColumnName?: string | null;
  isMaterialized?: boolean;
  domainValuesLoading?: boolean;
}
const SUPERSCRIPTS = {
  '0': '\u2070',
  '1': '\u00b9',
  '2': '\u00b2',
  '3': '\u00b3',
  '4': '\u2074',
  '5': '\u2075',
  '6': '\u2076',
  '7': '\u2077',
  '8': '\u2078',
  '9': '\u2079',
  '+': '\u207a',
  '-': '\u207b',
  'a': '\u1d43',
  'b': '\u1d47',
  'c': '\u1d9c',
  'd': '\u1d48',
  'e': '\u1d49',
  'f': '\u1da0',
  'g': '\u1d4d',
  'h': '\u02b0',
  'i': '\u2071',
  'j': '\u02b2',
  'k': '\u1d4f',
  'l': '\u02e1',
  'm': '\u1d50',
  'n': '\u207f',
  'o': '\u1d52',
  'p': '\u1d56',
  'r': '\u02b3',
  's': '\u02e2',
  't': '\u1d57',
  'u': '\u1d58',
  'v': '\u1d5b',
  'w': '\u02b7',
  'x': '\u02e3',
  'y': '\u02b8',
  'z': '\u1dbb'
}

function superScriptNumber(num: number, base: number = 10): string {
  var numStr = num.toString(base)
  if (numStr === 'NaN') { return '\u1d3a\u1d43\u1d3a' }
  if (numStr === 'Infinity') { return '\u207a\u1d35\u207f\u1da0' }
  if (numStr === '-Infinity') { return '\u207b\u1d35\u207f\u1da0' }
  return numStr.split('').map(function (c) {
    var supc = SUPERSCRIPTS[c as keyof typeof SUPERSCRIPTS]
    if (supc) {
      return supc
    }
    return ''
  }).join('')
}

// Columns to always hide
const HIDDEN_COLUMNS = ['is_sparse_break', 'is_dense_run', 'is_member'];

// Column display name mappings
const COLUMN_NAME_MAPPING: Record<string, string> = {
  'description': 'Text',
};

// Capitalize first letter of each word
function formatColumnName(name: string): string {
  if (COLUMN_NAME_MAPPING[name]) {
    return COLUMN_NAME_MAPPING[name];
  }
  if (name.startsWith('dim_')) {
    const dimIndex = name.slice(4);
    // Dimension is wildcard, add dimIndex as superscript
    return '* ' + superScriptNumber(Number(dimIndex));
  }
  return name.split('_').map(word =>
    word.charAt(0).toUpperCase() + word.slice(1)
  ).join(' ');
}

// Check if a column contains numeric values
function isNumericColumn(data: Record<string, unknown>[], columnName: string): boolean {
  for (const row of data) {
    const value = row[columnName];
    if (value !== null && value !== undefined) {
      return typeof value === 'number';
    }
  }
  return false;
}

// Format cell value based on column and display attributes
function formatCellValue(
  value: unknown,
  columnName: string,
  attributes: DisplayAttributes
): { display: string; isSpecial: boolean } {
  // Handle null values for upper/lower bounds
  if (value === null || value === undefined) {
    if (columnName === 'upper') {
      return { display: '+INF', isSpecial: true };
    }
    if (columnName === 'lower') {
      return { display: '-INF', isSpecial: true };
    }
    if (columnName === 'marginal') {
      return { display: 'EPS', isSpecial: true };
    }
    if (columnName === 'description') {
      return { display: 'Y', isSpecial: false };
    }
    return { display: 'NULL', isSpecial: true };
  }

  // Handle numbers
  if (typeof value === 'number') {
    // Check for special values
    if (!isFinite(value)) {
      if (value === Infinity) return { display: '+INF', isSpecial: true };
      if (value === -Infinity) return { display: '-INF', isSpecial: true };
      return { display: 'NaN', isSpecial: true };
    }

    // Squeeze defaults (typically 0 for level, scale, etc.)
    if (attributes.squeezeDefaults && value === 0) {
      return { display: '', isSpecial: false };
    }

    // Format number
    let formatted: string;
    switch (attributes.format) {
      case 'f-format':
        formatted = value.toFixed(attributes.precision);
        break;
      case 'e-format':
        formatted = value.toExponential(attributes.precision);
        break;
      case 'g-format':
      default:
        formatted = value.toPrecision(attributes.precision);
        // Convert to number and back to remove unnecessary precision
        formatted = parseFloat(formatted).toString();
        break;
    }

    // Squeeze trailing zeroes
    if (attributes.squeezeTrailingZeroes && formatted.includes('.')) {
      formatted = formatted.replace(/\.?0+$/, '');
    }

    return { display: formatted, isSpecial: false };
  }

  return { display: String(value), isSpecial: false };
}

const ROW_HEIGHT = 24;

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
  },
  tableWrapper: {
    flex: 1,
    overflow: 'auto',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  thead: {
    backgroundColor: 'var(--vscode-editorWidget-background)',
    position: 'sticky' as const,
    top: 0,
    zIndex: 10,
  },
  th: {
    padding: '2px 6px',
    textAlign: 'left' as const,
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
    borderBottom: '1px solid var(--vscode-panel-border, transparent)',
    whiteSpace: 'nowrap' as const,
    verticalAlign: 'top' as const,
  },
  headerContent: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  headerButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    background: 'none',
    border: 'none',
    padding: '2px 6px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
    borderRadius: '3px',
  },
  tr: {
    borderBottom: '1px solid var(--vscode-panel-border, transparent)',
  },
  td: {
    padding: '2px 6px',
    verticalAlign: 'middle' as const,
  },
  tdSpecial: {
    color: 'var(--vscode-descriptionForeground)',
    fontStyle: 'italic' as const,
  },
  tdNumber: {
    fontFamily: 'var(--vscode-editor-font-family)',
    textAlign: 'right' as const,
  },
  emptyRow: {
    textAlign: 'center' as const,
    padding: '24px',
    color: 'var(--vscode-descriptionForeground)',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 8px',
    borderTop: '1px solid var(--vscode-panel-border, transparent)',
    backgroundColor: 'var(--vscode-editorWidget-background)',
    gap: '12px',
    flexWrap: 'wrap' as const,
  },
  statusInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-descriptionForeground)',
    flexWrap: 'wrap' as const,
  },
};

export function DataTable({
  columns,
  data,
  totalRows,
  hasNextPage,
  isFetchingMore,
  onFetchMore,
  scrollToRowIndex,
  displayAttributes,
  filters,
  sorts,
  onFiltersChange,
  onSortsChange,
  domainValues,
  dimensionCount,
  highlightedRowKey,
  highlightedColumnName,
  isMaterialized = true,
  domainValuesLoading = false,
}: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const parentRef = useRef<HTMLDivElement>(null);

  // Convert ColumnSort[] to SortingState for display purposes
  useMemo(() => {
    const tanstackSorting: SortingState = sorts.map(sort => ({
      id: sort.columnName,
      desc: sort.direction === 'desc'
    }));
    setSorting(tanstackSorting);
  }, [sorts]);

  // Filter out hidden columns from display
  const visibleColumns = useMemo(() =>
    columns.filter(col => !HIDDEN_COLUMNS.includes(col)),
    [columns]
  );

  // Compute unique values for text columns from current data as fallback
  const columnUniqueValues = useMemo(() => {
    const values: Record<string, Set<string>> = {};
    visibleColumns.forEach(col => {
      if (!isNumericColumn(data, col)) {
        values[col] = new Set<string>();
        data.forEach(row => {
          const value = row[col];
          if (value !== null && value !== undefined) {
            values[col].add(String(value));
          }
        });
      }
    });
    return values;
  }, [data, visibleColumns]);

  // Helper to get current filter for a column
  const getColumnFilter = useCallback((columnName: string) => {
    const filter = filters.find(f => f.columnName === columnName);
    return filter?.filterValue;
  }, [filters]);

  // Helper to get current sort for a column
  const getColumnSort = useCallback((columnName: string) => {
    const sort = sorts.find(s => s.columnName === columnName);
    return sort;
  }, [sorts]);

  // Handle filter change from filter components
  const handleFilterChange = useCallback((columnName: string, filterValue: NumericFilterState | string[] | undefined) => {
    if (!isMaterialized) return;
    let newFilters: ColumnFilter[];
    if (filterValue === undefined) {
      newFilters = filters.filter(f => f.columnName !== columnName);
    } else {
      const existingIndex = filters.findIndex(f => f.columnName === columnName);
      if (existingIndex >= 0) {
        newFilters = [...filters];
        newFilters[existingIndex] = {
          columnName,
          filterValue: Array.isArray(filterValue)
            ? { selectedValues: filterValue }
            : filterValue
        };
      } else {
        newFilters = [
          ...filters,
          {
            columnName,
            filterValue: Array.isArray(filterValue)
              ? { selectedValues: filterValue }
              : filterValue
          }
        ];
      }
    }
    onFiltersChange(newFilters);
  }, [filters, onFiltersChange, isMaterialized]);

  // Handle sort change from column headers
  const handleSortChange = useCallback((columnName: string) => {
    if (!isMaterialized) return;
    const currentSort = getColumnSort(columnName);
    let newSorts: ColumnSort[];

    if (!currentSort) {
      newSorts = [{ columnName, direction: 'asc' }];
    } else if (currentSort.direction === 'asc') {
      newSorts = [{ columnName, direction: 'desc' }];
    } else {
      newSorts = [];
    }

    onSortsChange(newSorts);
  }, [sorts, getColumnSort, onSortsChange, isMaterialized]);

  // Cache column numeric/text type to prevent flip-flopping when data briefly becomes empty
  const columnTypesRef = useRef<Record<string, boolean>>({});
  const getIsNumeric = useCallback((col: string) => {
    if (data.length > 0) {
      columnTypesRef.current[col] = isNumericColumn(data, col);
    }
    return columnTypesRef.current[col] ?? false;
  }, [data]);

  // Helper to get domain values for a column with robust name matching
  const getDomainValuesForColumn = useCallback((columnName: string) => {
    if (domainValues.has(columnName)) {
      return domainValues.get(columnName);
    }

    const columnIndex = columns.indexOf(columnName);
    if (columnIndex !== -1 && columnIndex < dimensionCount) {
      const normalizedKey = `dim_${columnIndex + 1}`;
      if (domainValues.has(normalizedKey)) {
        return domainValues.get(normalizedKey);
      }
    }

    const dimMatch = columnName.match(/dim_?(\d+)/i);
    if (dimMatch) {
      const dimIndex = dimMatch[1];
      const normalizedKey = `dim_${dimIndex}`;
      if (domainValues.has(normalizedKey)) {
        return domainValues.get(normalizedKey);
      }
    }

    return undefined;
  }, [domainValues, columns, dimensionCount]);

  const tableColumns: ColumnDef<Record<string, unknown>>[] = useMemo(() => visibleColumns.map(
    (col) => {
      const isNumeric = getIsNumeric(col);
      const displayName = formatColumnName(col);

      return {
        accessorKey: col,
        header: ({ column }) => {
          const currentSort = getColumnSort(col);
          const currentFilter = getColumnFilter(col);

          return (
            <div style={styles.headerContent}>
              <button
                style={{
                  ...styles.headerButton,
                  ...(!isMaterialized ? { cursor: 'default', opacity: 0.7 } : {}),
                }}
                onClick={() => handleSortChange(col)}
                onMouseEnter={(e) => {
                  if (isMaterialized) e.currentTarget.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {displayName}
                <span style={{ opacity: currentSort ? 1 : 0.3 }}>
                  {currentSort?.direction === "asc" ? "\u2191" : currentSort?.direction === "desc" ? "\u2193" : "\u2195"}
                </span>
              </button>
              {isNumeric ? (
                <NumericFilter
                  columnName={col}
                  minValue={undefined}
                  maxValue={undefined}
                  currentFilter={currentFilter as NumericFilterState | undefined}
                  onFilterChange={handleFilterChange}
                />
              ) : (
                <TextFilter
                  columnName={col}
                  uniqueValues={getDomainValuesForColumn(col) || Array.from(columnUniqueValues[col] || []).sort()}
                  currentFilter={(currentFilter as any)?.selectedValues}
                  onFilterChange={(name, values) => handleFilterChange(name, values)}
                  domainValuesLoading={domainValuesLoading}
                />
              )}
            </div>
          );
        },
        cell: ({ row }) => {
          const value = row.getValue(col);
          const { display, isSpecial } = formatCellValue(value, col, displayAttributes);

          if (isSpecial) {
            return <span style={styles.tdSpecial}>{display}</span>;
          }
          if (isNumeric) {
            return <span style={styles.tdNumber}>{display}</span>;
          }
          return display;
        },
      };
    }
  ), [visibleColumns, getIsNumeric, getDomainValuesForColumn, columnUniqueValues,
      getColumnFilter, getColumnSort, handleFilterChange, handleSortChange,
      isMaterialized, displayAttributes, domainValuesLoading]);

  const table = useReactTable({
    data,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
    manualSorting: true,
    manualFiltering: true,
  });

  const allRows = table.getRowModel().rows;

  // Virtualizer for rows
  const rowVirtualizer = useVirtualizer({
    count: hasNextPage ? allRows.length + 1 : allRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Scroll to top when filters/sorts change
  const prevFiltersRef = useRef(filters);
  const prevSortsRef = useRef(sorts);
  useEffect(() => {
    if (prevFiltersRef.current !== filters || prevSortsRef.current !== sorts) {
      prevFiltersRef.current = filters;
      prevSortsRef.current = sorts;
      rowVirtualizer.scrollToOffset(0);
    }
  }, [filters, sorts, rowVirtualizer]);

  // Handle scrollToRowIndex
  useEffect(() => {
    if (scrollToRowIndex != null && scrollToRowIndex >= 0) {
      rowVirtualizer.scrollToIndex(scrollToRowIndex, { align: 'center' });
    }
  }, [scrollToRowIndex, rowVirtualizer]);

  // Fetch more when scrolling near the end
  const virtualItems = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    if (!hasNextPage || isFetchingMore || virtualItems.length === 0) return;
    const lastItem = virtualItems[virtualItems.length - 1];
    if (lastItem && lastItem.index >= allRows.length - 30) {
      onFetchMore();
    }
  }, [virtualItems, hasNextPage, isFetchingMore, allRows.length, onFetchMore]);

  const buildDimensionRowKey = useCallback((row: Record<string, unknown>): string | null => {
    if (dimensionCount <= 0) {
      return null;
    }

    const parts: string[] = [];
    for (let dim = 1; dim <= dimensionCount; dim++) {
      const columnName = `dim_${dim}`;
      const value = row[columnName];
      if (value === undefined || value === null) {
        return null;
      }
      parts.push(`${columnName}=${String(value)}`);
    }
    return parts.join('|');
  }, [dimensionCount]);

  const totalSize = rowVirtualizer.getTotalSize();

  return (
    <div style={styles.container}>
      {!isMaterialized && (
        <div style={{
          padding: '4px 12px',
          backgroundColor: 'var(--vscode-editorInfo-background, var(--vscode-editorWidget-background))',
          color: 'var(--vscode-descriptionForeground)',
          fontSize: 'var(--vscode-font-size)',
          fontFamily: 'var(--vscode-font-family)',
          borderBottom: '1px solid var(--vscode-panel-border, transparent)',
        }}>
          Showing preview &mdash; sorting and filtering available after loading completes
        </div>
      )}
      <div ref={parentRef} style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead style={styles.thead}>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th key={header.id} style={styles.th}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {allRows.length > 0 ? (
              <>
                {/* Top spacer */}
                {virtualItems.length > 0 && virtualItems[0].start > 0 && (
                  <tr>
                    <td
                      colSpan={visibleColumns.length}
                      style={{ height: virtualItems[0].start, padding: 0, border: 'none' }}
                    />
                  </tr>
                )}
                {/* Visible rows */}
                {virtualItems.map((virtualRow) => {
                  // Sentinel row for "loading more..."
                  if (virtualRow.index >= allRows.length) {
                    return (
                      <tr key="loading-sentinel" style={{ height: ROW_HEIGHT }}>
                        <td
                          colSpan={visibleColumns.length}
                          style={{
                            ...styles.td,
                            textAlign: 'center',
                            color: 'var(--vscode-descriptionForeground)',
                          }}
                        >
                          {isFetchingMore ? 'Loading more...' : ''}
                        </td>
                      </tr>
                    );
                  }

                  const row = allRows[virtualRow.index];
                  const rowKey = buildDimensionRowKey(row.original);
                  const isHighlightedRow = !!highlightedRowKey && rowKey === highlightedRowKey;
                  const baseRowBackground = isHighlightedRow
                    ? 'var(--vscode-list-activeSelectionBackground)'
                    : (virtualRow.index % 2 === 0 ? 'transparent' : 'var(--vscode-list-hoverBackground)');

                  return (
                    <tr
                      key={row.id}
                      style={{
                        ...styles.tr,
                        height: ROW_HEIGHT,
                        backgroundColor: baseRowBackground,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = baseRowBackground;
                      }}
                    >
                      {row.getVisibleCells().map((cell) => {
                        const isHighlightedCell = isHighlightedRow && highlightedColumnName === cell.column.id;
                        return (
                          <td
                            key={cell.id}
                            style={{
                              ...styles.td,
                              ...(isHighlightedCell
                                ? {
                                  outline: '1px solid var(--vscode-focusBorder)',
                                  backgroundColor: 'var(--vscode-list-activeSelectionBackground)',
                                }
                                : {}),
                            }}
                          >
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext()
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {/* Bottom spacer */}
                {virtualItems.length > 0 && (
                  <tr>
                    <td
                      colSpan={visibleColumns.length}
                      style={{
                        height: totalSize - (virtualItems[virtualItems.length - 1].end),
                        padding: 0,
                        border: 'none',
                      }}
                    />
                  </tr>
                )}
              </>
            ) : (
              <tr>
                <td colSpan={visibleColumns.length} style={styles.emptyRow}>
                  No results.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={styles.statusBar}>
        <div style={styles.statusInfo}>
          <span>
            {data.length.toLocaleString()} of {totalRows.toLocaleString()} rows{' '}
            {filters.length > 0 ? '(filtered)' : 'loaded'}
          </span>
          {isFetchingMore && (
            <>
              <span>&middot;</span>
              <span>Loading more...</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
