import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useState, useMemo, useCallback } from "react";
import { NumericFilter, type NumericFilterState } from "./NumericFilter";
import { TextFilter } from "./TextFilter";
import type { DisplayAttributes } from "./AttributesPanel";
import type { ColumnFilter, ColumnSort } from "../App";

interface DataTableProps {
  columns: string[];
  data: Record<string, unknown>[];
  pageIndex: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  displayAttributes: DisplayAttributes;
  filters: ColumnFilter[];
  sorts: ColumnSort[];
  onFiltersChange: (filters: ColumnFilter[]) => void;
  onSortsChange: (sorts: ColumnSort[]) => void;
  domainValues: Map<string, string[]>;
  dimensionCount: number;
  highlightedRowKey?: string | null;
  highlightedColumnName?: string | null;
}
const SUPERSCRIPTS = {
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹',
  '+': '⁺',
  '-': '⁻',
  'a': 'ᵃ',
  'b': 'ᵇ',
  'c': 'ᶜ',
  'd': 'ᵈ',
  'e': 'ᵉ',
  'f': 'ᶠ',
  'g': 'ᵍ',
  'h': 'ʰ',
  'i': 'ⁱ',
  'j': 'ʲ',
  'k': 'ᵏ',
  'l': 'ˡ',
  'm': 'ᵐ',
  'n': 'ⁿ',
  'o': 'ᵒ',
  'p': 'ᵖ',
  'r': 'ʳ',
  's': 'ˢ',
  't': 'ᵗ',
  'u': 'ᵘ',
  'v': 'ᵛ',
  'w': 'ʷ',
  'x': 'ˣ',
  'y': 'ʸ',
  'z': 'ᶻ'
}

function superScriptNumber(num: number, base: number = 10): string {
  var numStr = num.toString(base)
  if (numStr === 'NaN') { return 'ᴺᵃᴺ' }
  if (numStr === 'Infinity') { return '⁺ᴵⁿᶠ' }
  if (numStr === '-Infinity') { return '⁻ᴵⁿᶠ' }
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
    padding: '4px 8px',
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
    gap: '4px',
  },
  headerButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    background: 'none',
    border: 'none',
    padding: '4px 8px',
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
    padding: '6px 12px',
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
  pagination: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 12px',
    borderTop: '1px solid var(--vscode-panel-border, transparent)',
    backgroundColor: 'var(--vscode-editorWidget-background)',
    gap: '12px',
    flexWrap: 'wrap' as const,
  },
  pageInfo: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-descriptionForeground)',
    flexWrap: 'wrap' as const,
  },
  select: {
    backgroundColor: 'var(--vscode-dropdown-background)',
    color: 'var(--vscode-dropdown-foreground)',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, transparent))',
    borderRadius: '3px',
    padding: '2px 6px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  pageButtons: {
    display: 'flex',
    gap: '4px',
  },
  pageButton: {
    padding: '4px 8px',
    backgroundColor: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  pageButtonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
};

export function DataTable({
  columns,
  data,
  pageIndex,
  pageSize,
  totalRows,
  onPageChange,
  onPageSizeChange,
  displayAttributes,
  filters,
  sorts,
  onFiltersChange,
  onSortsChange,
  domainValues,
  dimensionCount,
  highlightedRowKey,
  highlightedColumnName,
}: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);

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
  // This provides filter options if domain values haven't loaded yet
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
    let newFilters: ColumnFilter[];
    if (filterValue === undefined) {
      // Remove filter
      newFilters = filters.filter(f => f.columnName !== columnName);
    } else {
      // Add or update filter
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
  }, [filters, onFiltersChange]);

  // Handle sort change from column headers
  const handleSortChange = useCallback((columnName: string) => {
    const currentSort = getColumnSort(columnName);
    let newSorts: ColumnSort[];

    if (!currentSort) {
      // Add ascending sort
      newSorts = [{ columnName, direction: 'asc' }];
    } else if (currentSort.direction === 'asc') {
      // Change to descending
      newSorts = [{ columnName, direction: 'desc' }];
    } else {
      // Remove sort
      newSorts = [];
    }

    onSortsChange(newSorts);
  }, [sorts, getColumnSort, onSortsChange]);

  // Helper to get domain values for a column with robust name matching
  const getDomainValuesForColumn = useCallback((columnName: string) => {
    // Try exact match first
    if (domainValues.has(columnName)) {
      return domainValues.get(columnName);
    }

    // Check matching by column index
    // GDX reader usually returns columns in order: dim_1, dim_2, ..., dim_n, value columns
    // The domain values are keyed by "dim_1", "dim_2", etc.
    const columnIndex = columns.indexOf(columnName);
    if (columnIndex !== -1 && columnIndex < dimensionCount) {
      const normalizedKey = `dim_${columnIndex + 1}`;
      if (domainValues.has(normalizedKey)) {
        return domainValues.get(normalizedKey);
      }
    }

    // Check for dimension named "dim_X" explicitly (fallback)
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

  const tableColumns: ColumnDef<Record<string, unknown>>[] = visibleColumns.map(
    (col) => {
      const isNumeric = isNumericColumn(data, col);
      const displayName = formatColumnName(col);

      return {
        accessorKey: col,
        header: ({ column }) => {
          const currentSort = getColumnSort(col);
          const currentFilter = getColumnFilter(col);

          return (
            <div style={styles.headerContent}>
              <button
                style={styles.headerButton}
                onClick={() => handleSortChange(col)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                {displayName}
                <span style={{ opacity: currentSort ? 1 : 0.3 }}>
                  {currentSort?.direction === "asc" ? "↑" : currentSort?.direction === "desc" ? "↓" : "↕"}
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
  );

  const table = useReactTable({
    data,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    state: {
      sorting,
    },
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  });

  const totalPages = Math.ceil(totalRows / pageSize);
  const canPreviousPage = pageIndex > 0;
  const canNextPage = pageIndex < totalPages - 1;

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

  return (
    <div style={styles.container}>
      <div style={styles.tableWrapper}>
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
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row, idx) => (
                (() => {
                  const rowKey = buildDimensionRowKey(row.original);
                  const isHighlightedRow = !!highlightedRowKey && rowKey === highlightedRowKey;
                  const baseRowBackground = isHighlightedRow
                    ? 'var(--vscode-list-activeSelectionBackground)'
                    : (idx % 2 === 0 ? 'transparent' : 'var(--vscode-list-hoverBackground)');

                  return (
                    <tr
                      key={row.id}
                      style={{
                        ...styles.tr,
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
                })()
              ))
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
      <div style={styles.pagination}>
        <div style={styles.pageInfo}>
          <span>Page {pageIndex + 1} of {totalPages || 1}</span>
          <span>·</span>
          <span>
            {filters.length > 0
              ? `${data.length} rows on page (filtered)`
              : `${totalRows.toLocaleString()} total rows`
            }
          </span>
          <span>·</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            style={styles.select}
          >
            {[1000, 10000, 50000].map((size) => (
              <option key={size} value={size}>
                {size} rows
              </option>
            ))}
          </select>
        </div>
        <div style={styles.pageButtons}>
          <button
            style={{
              ...styles.pageButton,
              ...(canPreviousPage ? {} : styles.pageButtonDisabled),
            }}
            onClick={() => canPreviousPage && onPageChange(0)}
            disabled={!canPreviousPage}
          >
            First
          </button>
          <button
            style={{
              ...styles.pageButton,
              ...(canPreviousPage ? {} : styles.pageButtonDisabled),
            }}
            onClick={() => canPreviousPage && onPageChange(pageIndex - 1)}
            disabled={!canPreviousPage}
          >
            Previous
          </button>
          <button
            style={{
              ...styles.pageButton,
              ...(canNextPage ? {} : styles.pageButtonDisabled),
            }}
            onClick={() => canNextPage && onPageChange(pageIndex + 1)}
            disabled={!canNextPage}
          >
            Next
          </button>
          <button
            style={{
              ...styles.pageButton,
              ...(canNextPage ? {} : styles.pageButtonDisabled),
            }}
            onClick={() => canNextPage && onPageChange(totalPages - 1)}
            disabled={!canNextPage}
          >
            Last
          </button>
        </div>
      </div>
    </div>
  );
}
