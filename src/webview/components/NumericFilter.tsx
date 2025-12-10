import { useState, useRef, useEffect } from "react";

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

interface NumericFilterProps {
  columnName: string;
  minValue?: number;
  maxValue?: number;
  currentFilter: NumericFilterState | undefined;
  onFilterChange: (columnName: string, filterState: NumericFilterState | undefined) => void;
}

const styles = {
  container: {
    position: 'relative' as const,
  },
  filterButton: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px 6px',
    backgroundColor: 'transparent',
    color: 'var(--vscode-descriptionForeground)',
    border: '1px solid var(--vscode-panel-border, transparent)',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'calc(var(--vscode-font-size) - 1px)',
    minWidth: '100px',
    justifyContent: 'space-between',
  },
  filterButtonActive: {
    backgroundColor: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderColor: 'var(--vscode-badge-background)',
  },
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    zIndex: 100,
    minWidth: '280px',
    backgroundColor: 'var(--vscode-dropdown-background)',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))',
    borderRadius: '3px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
    marginTop: '2px',
    padding: '12px',
  },
  row: {
    display: 'flex',
    gap: '12px',
    marginBottom: '12px',
  },
  inputGroup: {
    flex: 1,
  },
  label: {
    display: 'block',
    marginBottom: '4px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-foreground)',
  },
  input: {
    width: '100%',
    padding: '4px 8px',
    backgroundColor: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent))',
    borderRadius: '3px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    boxSizing: 'border-box' as const,
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    marginBottom: '12px',
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
  },
  checkbox: {
    width: '14px',
    height: '14px',
    accentColor: 'var(--vscode-checkbox-background)',
  },
  sectionTitle: {
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
    marginBottom: '8px',
  },
  specialValuesGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '8px',
    marginBottom: '12px',
  },
  actions: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
    borderTop: '1px solid var(--vscode-panel-border, transparent)',
    paddingTop: '12px',
  },
  actionButton: {
    padding: '4px 12px',
    backgroundColor: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  applyButton: {
    padding: '4px 12px',
    backgroundColor: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
};

const defaultState: NumericFilterState = {
  min: undefined,
  max: undefined,
  exclude: false,
  showEPS: true,
  showNA: true,
  showPosInf: true,
  showNegInf: true,
  showUNDF: true,
  showAcronyms: true,
};

export function NumericFilter({ columnName, minValue, maxValue, currentFilter, onFilterChange }: NumericFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterState, setFilterState] = useState<NumericFilterState>(currentFilter || defaultState);
  const [dropdownPosition, setDropdownPosition] = useState<'left' | 'right'>('left');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const isActive = currentFilter !== undefined && (
    currentFilter.min !== undefined || 
    currentFilter.max !== undefined || 
    currentFilter.exclude ||
    !currentFilter.showEPS ||
    !currentFilter.showNA ||
    !currentFilter.showPosInf ||
    !currentFilter.showNegInf ||
    !currentFilter.showUNDF ||
    !currentFilter.showAcronyms
  );

  // Calculate dropdown position when opening
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const buttonRect = buttonRef.current.getBoundingClientRect();
      const dropdownWidth = 280; // minWidth of dropdown
      const viewportWidth = window.innerWidth;
      
      // Check if dropdown would overflow to the right
      if (buttonRect.left + dropdownWidth > viewportWidth - 20) {
        setDropdownPosition('right');
      } else {
        setDropdownPosition('left');
      }
    }
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleReset = () => {
    setFilterState(defaultState);
    onFilterChange(columnName, undefined);
  };

  const handleApply = () => {
    onFilterChange(columnName, filterState);
    setIsOpen(false);
  };

  // Sync local state with current filter when opening
  useEffect(() => {
    if (isOpen && currentFilter) {
      setFilterState(currentFilter);
    } else if (isOpen && !currentFilter) {
      setFilterState(defaultState);
    }
  }, [isOpen, currentFilter]);

  return (
    <div style={styles.container}>
      <button
        ref={buttonRef}
        style={{
          ...styles.filterButton,
          ...(isActive ? styles.filterButtonActive : {}),
        }}
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={(e) => {
          if (!isActive) {
            e.currentTarget.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isActive) {
            e.currentTarget.style.backgroundColor = 'transparent';
          }
        }}
        title="Filter numeric values"
      >
        <span>{isActive ? "Filtered" : "Filter..."}</span>
        <span>{isOpen ? "▲" : "▼"}</span>
      </button>

      {isOpen && (
        <div 
          ref={dropdownRef} 
          style={{
            ...styles.dropdown,
            left: dropdownPosition === 'left' ? 0 : 'auto',
            right: dropdownPosition === 'right' ? 0 : 'auto',
          }}
        >
          {/* Min/Max Row */}
          <div style={styles.row}>
            <div style={styles.inputGroup}>
              <label style={styles.label}>Min:</label>
              <input
                type="number"
                style={styles.input}
                value={filterState.min ?? ''}
                onChange={(e) => setFilterState({
                  ...filterState,
                  min: e.target.value ? Number(e.target.value) : undefined
                })}
                placeholder={minValue?.toString() ?? ''}
              />
            </div>
            <div style={styles.inputGroup}>
              <label style={styles.label}>Max:</label>
              <input
                type="number"
                style={styles.input}
                value={filterState.max ?? ''}
                onChange={(e) => setFilterState({
                  ...filterState,
                  max: e.target.value ? Number(e.target.value) : undefined
                })}
                placeholder={maxValue?.toString() ?? ''}
              />
            </div>
          </div>

          {/* Exclude Checkbox */}
          <div style={styles.checkboxRow}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={filterState.exclude}
                onChange={(e) => setFilterState({ ...filterState, exclude: e.target.checked })}
              />
              Exclude
            </label>
          </div>

          {/* Special Values Section */}
          <div style={styles.sectionTitle}>Show Special Values:</div>
          <div style={styles.specialValuesGrid}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={filterState.showEPS}
                onChange={(e) => setFilterState({ ...filterState, showEPS: e.target.checked })}
              />
              EPS
            </label>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={filterState.showPosInf}
                onChange={(e) => setFilterState({ ...filterState, showPosInf: e.target.checked })}
              />
              +INF
            </label>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={filterState.showNegInf}
                onChange={(e) => setFilterState({ ...filterState, showNegInf: e.target.checked })}
              />
              -INF
            </label>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={filterState.showNA}
                onChange={(e) => setFilterState({ ...filterState, showNA: e.target.checked })}
              />
              NA
            </label>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={filterState.showUNDF}
                onChange={(e) => setFilterState({ ...filterState, showUNDF: e.target.checked })}
              />
              UNDF
            </label>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={filterState.showAcronyms}
                onChange={(e) => setFilterState({ ...filterState, showAcronyms: e.target.checked })}
              />
              Acronyms
            </label>
          </div>

          {/* Action Buttons */}
          <div style={styles.actions}>
            <button
              style={styles.actionButton}
              onClick={handleReset}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-secondaryHoverBackground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-secondaryBackground)';
              }}
            >
              Reset
            </button>
            <button
              style={styles.applyButton}
              onClick={handleApply}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-hoverBackground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-background)';
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
