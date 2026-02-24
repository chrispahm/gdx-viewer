/**
 * Shared filter type definitions used by both server and webview.
 */

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
