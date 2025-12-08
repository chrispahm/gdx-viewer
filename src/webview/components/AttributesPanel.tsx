import { useState, useRef, useEffect } from "react";

export interface DisplayAttributes {
  squeezeDefaults: boolean;
  squeezeTrailingZeroes: boolean;
  format: 'g-format' | 'f-format' | 'e-format';
  precision: number;
}

interface AttributesPanelProps {
  attributes: DisplayAttributes;
  onChange: (attributes: DisplayAttributes) => void;
}

const styles = {
  container: {
    position: 'relative' as const,
  },
  button: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '4px 8px',
    backgroundColor: 'transparent',
    color: 'var(--vscode-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    fontWeight: 600,
    transition: 'background-color 0.15s',
  },
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    zIndex: 100,
    minWidth: '220px',
    backgroundColor: 'var(--vscode-dropdown-background)',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))',
    borderRadius: '3px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
    marginTop: '2px',
    padding: '8px 0',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '4px 12px 8px',
    borderBottom: '1px solid var(--vscode-panel-border, transparent)',
    marginBottom: '8px',
  },
  headerTitle: {
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    fontWeight: 500,
    color: 'var(--vscode-foreground)',
  },
  resetButton: {
    padding: '2px 8px',
    backgroundColor: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'calc(var(--vscode-font-size) - 1px)',
  },
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-foreground)',
  },
  checkbox: {
    width: '14px',
    height: '14px',
    accentColor: 'var(--vscode-checkbox-background)',
  },
  separator: {
    height: '1px',
    backgroundColor: 'var(--vscode-panel-border, transparent)',
    margin: '8px 0',
  },
  selectRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px',
  },
  selectLabel: {
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    color: 'var(--vscode-foreground)',
  },
  select: {
    padding: '2px 6px',
    backgroundColor: 'var(--vscode-dropdown-background)',
    color: 'var(--vscode-dropdown-foreground)',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, transparent))',
    borderRadius: '3px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  precisionRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px',
  },
  precisionInput: {
    width: '60px',
    padding: '2px 6px',
    backgroundColor: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent))',
    borderRadius: '3px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    textAlign: 'right' as const,
  },
  spinButtons: {
    display: 'flex',
    flexDirection: 'column' as const,
    marginLeft: '4px',
  },
  spinButton: {
    padding: '0 4px',
    backgroundColor: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '8px',
    lineHeight: 1,
  },
};

const defaultAttributes: DisplayAttributes = {
  squeezeDefaults: false,
  squeezeTrailingZeroes: true,
  format: 'g-format',
  precision: 6,
};

export function AttributesPanel({ attributes, onChange }: AttributesPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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
    onChange(defaultAttributes);
  };

  return (
    <div style={styles.container}>
      <button
        ref={buttonRef}
        style={styles.button}
        onClick={() => setIsOpen(!isOpen)}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
        title="Display attributes"
      >
        Attributes
      </button>

      {isOpen && (
        <div ref={dropdownRef} style={styles.dropdown}>
          {/* Header */}
          <div style={styles.header}>
            <span style={styles.headerTitle}>Preferences</span>
            <button
              style={styles.resetButton}
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
          </div>

          {/* Squeeze Defaults */}
          <div
            style={styles.menuItem}
            onClick={() => onChange({ ...attributes, squeezeDefaults: !attributes.squeezeDefaults })}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={attributes.squeezeDefaults}
              onChange={() => onChange({ ...attributes, squeezeDefaults: !attributes.squeezeDefaults })}
              onClick={(e) => e.stopPropagation()}
            />
            <span>Squeeze Defaults</span>
          </div>

          {/* Squeeze Trailing Zeroes */}
          <div
            style={styles.menuItem}
            onClick={() => onChange({ ...attributes, squeezeTrailingZeroes: !attributes.squeezeTrailingZeroes })}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <input
              type="checkbox"
              style={styles.checkbox}
              checked={attributes.squeezeTrailingZeroes}
              onChange={() => onChange({ ...attributes, squeezeTrailingZeroes: !attributes.squeezeTrailingZeroes })}
              onClick={(e) => e.stopPropagation()}
            />
            <span>Squeeze Trailing Zeroes</span>
          </div>

          <div style={styles.separator} />

          {/* Format */}
          <div style={styles.selectRow}>
            <span style={styles.selectLabel}>Format:</span>
            <select
              style={styles.select}
              value={attributes.format}
              onChange={(e) => onChange({ ...attributes, format: e.target.value as DisplayAttributes['format'] })}
            >
              <option value="g-format">g-format</option>
              <option value="f-format">f-format</option>
              <option value="e-format">e-format</option>
            </select>
          </div>

          {/* Precision */}
          <div style={styles.precisionRow}>
            <span style={styles.selectLabel}>Precision:</span>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <input
                type="number"
                style={styles.precisionInput}
                value={attributes.precision}
                onChange={(e) => onChange({ ...attributes, precision: Math.max(0, Math.min(15, parseInt(e.target.value) || 0)) })}
                min={0}
                max={15}
              />
              <div style={styles.spinButtons}>
                <button
                  style={styles.spinButton}
                  onClick={() => onChange({ ...attributes, precision: Math.min(15, attributes.precision + 1) })}
                >
                  ▲
                </button>
                <button
                  style={styles.spinButton}
                  onClick={() => onChange({ ...attributes, precision: Math.max(0, attributes.precision - 1) })}
                >
                  ▼
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
