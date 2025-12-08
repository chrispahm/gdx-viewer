import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
} from "@tanstack/react-table";
import { useState, useMemo } from "react";
import { NumericFilter } from "./NumericFilter";
import { TextFilter } from "./TextFilter";
import type { DisplayAttributes } from "./AttributesPanel";

interface DataTableProps {
  columns: string[];
  data: Record<string, unknown>[];
  pageIndex: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (pageIndex: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  displayAttributes: DisplayAttributes;
}

// Columns to always hide
const HIDDEN_COLUMNS = ['is_sparse_break', 'is_dense_run'];

// Column display name mappings
const COLUMN_NAME_MAPPING: Record<string, string> = {
  'is_member': 'Text',
};

// Capitalize first letter of each word
function formatColumnName(name: string): string {
  if (COLUMN_NAME_MAPPING[name]) {
    return COLUMN_NAME_MAPPING[name];
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
    return { display: 'NULL', isSpecial: true };
  }

  // Handle is_member column
  if (columnName === 'is_member') {
    return { display: value ? 'Y' : 'N', isSpecial: false };
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
}: DataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  
  // Initialize column visibility - hide specified columns
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>(() => {
    const visibility: VisibilityState = {};
    HIDDEN_COLUMNS.forEach(col => {
      visibility[col] = false;
    });
    return visibility;
  });

  // Filter out hidden columns from display
  const visibleColumns = useMemo(() => 
    columns.filter(col => !HIDDEN_COLUMNS.includes(col)),
    [columns]
  );

  // Compute unique values for each column for faceted filtering
  const columnUniqueValues = useMemo(() => {
    const values: Record<string, Set<string>> = {};
    visibleColumns.forEach(col => {
      values[col] = new Set<string>();
    });
    data.forEach(row => {
      visibleColumns.forEach(col => {
        const value = row[col];
        if (value !== null && value !== undefined) {
          values[col].add(String(value));
        }
      });
    });
    return values;
  }, [data, visibleColumns]);

  // Compute min/max for numeric columns
  const numericColumnStats = useMemo(() => {
    const stats: Record<string, { min: number; max: number }> = {};
    visibleColumns.forEach(col => {
      if (isNumericColumn(data, col)) {
        let min = Infinity;
        let max = -Infinity;
        data.forEach(row => {
          const value = row[col];
          if (typeof value === 'number' && isFinite(value)) {
            min = Math.min(min, value);
            max = Math.max(max, value);
          }
        });
        if (isFinite(min) && isFinite(max)) {
          stats[col] = { min, max };
        }
      }
    });
    return stats;
  }, [data, visibleColumns]);

  const tableColumns: ColumnDef<Record<string, unknown>>[] = visibleColumns.map(
    (col) => {
      const isNumeric = isNumericColumn(data, col);
      const displayName = formatColumnName(col);
      
      return {
        accessorKey: col,
        header: ({ column }) => (
          <div style={styles.headerContent}>
            <button
              style={styles.headerButton}
              onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              {displayName}
              <span style={{ opacity: column.getIsSorted() ? 1 : 0.3 }}>
                {column.getIsSorted() === "asc" ? "↑" : column.getIsSorted() === "desc" ? "↓" : "↕"}
              </span>
            </button>
            {isNumeric ? (
              <NumericFilter
                column={column}
                minValue={numericColumnStats[col]?.min}
                maxValue={numericColumnStats[col]?.max}
              />
            ) : (
              <TextFilter
                column={column}
                uniqueValues={Array.from(columnUniqueValues[col] || []).sort()}
              />
            )}
          </div>
        ),
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
        filterFn: (row, columnId, filterValue) => {
          // Handle text filter (array of selected values)
          if (Array.isArray(filterValue)) {
            if (filterValue.length === 0) return true;
            const value = row.getValue(columnId);
            const stringValue = value === null || value === undefined ? '' : String(value);
            return filterValue.includes(stringValue);
          }
          // Handle numeric filter
          if (filterValue && typeof filterValue === 'object') {
            const value = row.getValue(columnId);
            if (typeof value !== 'number') return true;
            
            const { min, max, exclude } = filterValue as { min?: number; max?: number; exclude: boolean };
            let inRange = true;
            
            if (min !== undefined && value < min) inRange = false;
            if (max !== undefined && value > max) inRange = false;
            
            return exclude ? !inRange : inRange;
          }
          return true;
        },
      };
    }
  );

  const table = useReactTable({
    data,
    columns: tableColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
    },
    manualPagination: true,
  });

  const filteredRowCount = table.getFilteredRowModel().rows.length;
  const totalPages = Math.ceil(totalRows / pageSize);
  const canPreviousPage = pageIndex > 0;
  const canNextPage = pageIndex < totalPages - 1;

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
                <tr 
                  key={row.id} 
                  style={{
                    ...styles.tr,
                    backgroundColor: idx % 2 === 0 ? 'transparent' : 'var(--vscode-list-hoverBackground)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = idx % 2 === 0 ? 'transparent' : 'var(--vscode-list-hoverBackground)';
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} style={styles.td}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </td>
                  ))}
                </tr>
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
            {filteredRowCount !== data.length 
              ? `${filteredRowCount} of ${data.length} rows (filtered)`
              : `${totalRows.toLocaleString()} total rows`
            }
          </span>
          <span>·</span>
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            style={styles.select}
          >
            {[10, 25, 50, 100].map((size) => (
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
