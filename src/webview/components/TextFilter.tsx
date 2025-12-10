import { useState, useRef, useEffect } from "react";

interface TextFilterProps {
  columnName: string;
  uniqueValues: string[];
  currentFilter: string[] | undefined;
  onFilterChange: (columnName: string, selectedValues: string[] | undefined) => void;
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
    maxWidth: '400px',
    backgroundColor: 'var(--vscode-dropdown-background)',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))',
    borderRadius: '3px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
    marginTop: '2px',
  },
  searchRow: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px',
    borderBottom: '1px solid var(--vscode-panel-border, transparent)',
    gap: '8px',
  },
  searchInput: {
    flex: 1,
    padding: '4px 8px',
    backgroundColor: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent))',
    borderRadius: '3px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  iconButton: {
    padding: '4px',
    backgroundColor: 'transparent',
    color: 'var(--vscode-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    opacity: 0.7,
  },
  optionsList: {
    maxHeight: '250px',
    overflow: 'auto',
  },
  option: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-dropdown-foreground)',
  },
  checkbox: {
    width: '14px',
    height: '14px',
    accentColor: 'var(--vscode-checkbox-background)',
  },
  optionLabel: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  actions: {
    display: 'flex',
    gap: '8px',
    padding: '8px 12px',
    borderTop: '1px solid var(--vscode-panel-border, transparent)',
  },
  actionButton: {
    flex: 1,
    padding: '4px 8px',
    backgroundColor: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'calc(var(--vscode-font-size) - 1px)',
  },
  bottomSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    padding: '8px 12px',
    borderTop: '1px solid var(--vscode-panel-border, transparent)',
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
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
  applyButton: {
    padding: '6px 16px',
    backgroundColor: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    alignSelf: 'flex-end' as const,
  },
  noResults: {
    padding: '12px',
    color: 'var(--vscode-descriptionForeground)',
    fontStyle: 'italic' as const,
    textAlign: 'center' as const,
  },
};

export function TextFilter({ columnName, uniqueValues, currentFilter, onFilterChange }: TextFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedValues, setSelectedValues] = useState<Set<string>>(new Set(uniqueValues));
  const [hideUnselected, setHideUnselected] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<'left' | 'right'>('left');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const filterValue = currentFilter || [];
  const isActive = filterValue.length > 0 && filterValue.length < uniqueValues.length;

  // Filter values based on search term
  const filteredValues = uniqueValues.filter((value) =>
    value.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Values to display based on hideUnselected
  const displayValues = hideUnselected
    ? filteredValues.filter((v) => selectedValues.has(v))
    : filteredValues;

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

  // Sync selectedValues with filter value when opening
  useEffect(() => {
    if (isOpen) {
      if (filterValue.length > 0) {
        setSelectedValues(new Set(filterValue));
      } else {
        setSelectedValues(new Set(uniqueValues));
      }
    }
  }, [isOpen]);

  const toggleValue = (value: string) => {
    const newSet = new Set(selectedValues);
    if (newSet.has(value)) {
      newSet.delete(value);
    } else {
      newSet.add(value);
    }
    setSelectedValues(newSet);
  };

  const selectAll = () => {
    setSelectedValues(new Set(uniqueValues));
  };

  const invertSelection = () => {
    const newSet = new Set<string>();
    uniqueValues.forEach((v) => {
      if (!selectedValues.has(v)) {
        newSet.add(v);
      }
    });
    setSelectedValues(newSet);
  };

  const deselectAll = () => {
    setSelectedValues(new Set());
  };

  const handleApply = () => {
    // If all values selected, clear filter
    if (selectedValues.size === uniqueValues.length) {
      onFilterChange(columnName, undefined);
    } else {
      onFilterChange(columnName, Array.from(selectedValues));
    }
    setIsOpen(false);
  };

  if (uniqueValues.length === 0) {
    return null;
  }

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
        title={isActive ? `${filterValue.length} of ${uniqueValues.length} selected` : "Filter values"}
      >
        <span>{isActive ? `${filterValue.length} selected` : "Filter..."}</span>
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
          {/* Search Row */}
          <div style={styles.searchRow}>
            <input
              type="text"
              placeholder="Filter ..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={styles.searchInput}
              autoFocus
            />
            <button
              style={styles.iconButton}
              onClick={() => setSearchTerm("")}
              title="Clear search"
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.7';
              }}
            >
              ✕
            </button>
          </div>

          {/* Options List */}
          <div style={styles.optionsList}>
            {displayValues.length > 0 ? (
              displayValues.map((value) => (
                <div
                  key={value}
                  style={styles.option}
                  onClick={() => toggleValue(value)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedValues.has(value)}
                    onChange={() => toggleValue(value)}
                    style={styles.checkbox}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span style={styles.optionLabel} title={value}>
                    {value || "(empty)"}
                  </span>
                </div>
              ))
            ) : (
              <div style={styles.noResults}>No matching values</div>
            )}
          </div>

          {/* Action Buttons */}
          <div style={styles.actions}>
            <button
              style={styles.actionButton}
              onClick={selectAll}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-secondaryHoverBackground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-secondaryBackground)';
              }}
            >
              Select All
            </button>
            <button
              style={styles.actionButton}
              onClick={invertSelection}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-secondaryHoverBackground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-secondaryBackground)';
              }}
            >
              Invert
            </button>
            <button
              style={styles.actionButton}
              onClick={deselectAll}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-secondaryHoverBackground)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-secondaryBackground)';
              }}
            >
              Deselect All
            </button>
          </div>

          {/* Bottom Section */}
          <div style={styles.bottomSection}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={hideUnselected}
                onChange={(e) => setHideUnselected(e.target.checked)}
              />
              Hide unselected items
            </label>
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
