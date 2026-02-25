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
export function isNumericFilter(filter: FilterValue): filter is NumericFilterState {
  return 'exclude' in filter;
}

// SQL Builder function — queries materialized table by name
export function buildSqlQuery(
  tableName: string,
  filters: ColumnFilter[],
  sorts: ColumnSort[],
  limit: number,
  offset: number
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
      if (!filterValue.showEPS) {
        excludedSpecialValues.push('EPS');
      }
      if (!filterValue.showNA) {
        excludedSpecialValues.push('NA');
      }
      if (!filterValue.showUNDF) {
        excludedSpecialValues.push('UNDF');
      }

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
  sql += ` LIMIT ${limit} OFFSET ${offset}`;

  return sql;
}
