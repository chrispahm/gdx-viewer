import { useState, useRef, useEffect } from "react";
import { AttributesPanel, type DisplayAttributes } from "./AttributesPanel";

interface SqlToolbarProps {
  defaultQuery: string;
  onExecute: (sql: string) => void;
  isLoading: boolean;
  displayAttributes: DisplayAttributes;
  onAttributesChange: (attributes: DisplayAttributes) => void;
  onExport: (format: 'csv' | 'parquet' | 'excel', query: string) => void;
  isExporting?: boolean;
}

export function SqlToolbar({ 
  defaultQuery, 
  onExecute, 
  isLoading,
  displayAttributes,
  onAttributesChange,
  onExport,
  isExporting = false,
}: SqlToolbarProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [query, setQuery] = useState(defaultQuery);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Update local query when defaultQuery changes
  useEffect(() => {
    setQuery(defaultQuery);
  }, [defaultQuery]);

  // Focus input when expanded
  useEffect(() => {
    if (isExpanded && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isExpanded]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onExecute(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      onExecute(query);
    }
    if (e.key === "Escape") {
      setIsExpanded(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: 'var(--vscode-editorWidget-background)',
      borderBottom: '1px solid var(--vscode-panel-border, transparent)'
    }}>
      {/* Toolbar row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '4px 8px',
        minHeight: '28px',
        gap: '4px'
      }}>
        <AttributesPanel
          attributes={displayAttributes}
          onChange={onAttributesChange}
        />
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setIsExportOpen(!isExportOpen)}
            disabled={isLoading || isExporting}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px 8px',
              backgroundColor: isExportOpen
                ? 'var(--vscode-button-background)'
                : 'transparent',
              color: isExportOpen
                ? 'var(--vscode-button-foreground)'
                : 'var(--vscode-foreground)',
              border: 'none',
              borderRadius: '3px',
              cursor: isLoading || isExporting ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--vscode-font-family)',
              fontSize: 'var(--vscode-font-size)',
              fontWeight: 600,
              opacity: isLoading || isExporting ? 0.5 : 1,
              transition: 'background-color 0.15s'
            }}
            onMouseEnter={(e) => {
              if (!isExportOpen && !isLoading && !isExporting) {
                e.currentTarget.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isExportOpen) {
                e.currentTarget.style.backgroundColor = 'transparent';
              }
            }}
            title="Export data"
          >
            Export
          </button>

          {isExportOpen && (
            <div style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              marginTop: '4px',
              backgroundColor: 'var(--vscode-dropdown-background)',
              border: '1px solid var(--vscode-dropdown-border, var(--vscode-panel-border))',
              borderRadius: '3px',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
              minWidth: '180px',
              zIndex: 20,
              overflow: 'hidden'
            }}>
              {[
                { label: 'Export to CSV', value: 'csv' },
                { label: 'Export to Excel', value: 'excel' },
                { label: 'Export to Parquet', value: 'parquet' },
              ].map(option => (
                <button
                  key={option.value}
                  onClick={() => {
                    setIsExportOpen(false);
                    onExport(option.value as 'csv' | 'excel' | 'parquet', query);
                  }}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 12px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--vscode-foreground)',
                    cursor: 'pointer',
                    fontFamily: 'var(--vscode-font-family)',
                    fontSize: 'var(--vscode-font-size)'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                  disabled={isLoading || isExporting}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          disabled={isLoading}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4px 8px',
            backgroundColor: isExpanded 
              ? 'var(--vscode-button-background)' 
              : 'transparent',
            color: isExpanded 
              ? 'var(--vscode-button-foreground)' 
              : 'var(--vscode-foreground)',
            border: 'none',
            borderRadius: '3px',
            cursor: isLoading ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--vscode-font-family)',
            fontSize: 'var(--vscode-font-size)',
            fontWeight: 600,
            opacity: isLoading ? 0.5 : 1,
            transition: 'background-color 0.15s'
          }}
          onMouseEnter={(e) => {
            if (!isExpanded && !isLoading) {
              e.currentTarget.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
            }
          }}
          onMouseLeave={(e) => {
            if (!isExpanded) {
              e.currentTarget.style.backgroundColor = 'transparent';
            }
          }}
          title={isExpanded ? "Close SQL editor" : "Open SQL editor (Ctrl+Enter to run)"}
        >
          SQL
        </button>
      </div>

      {/* Expandable SQL input panel */}
      {isExpanded && (
        <form onSubmit={handleSubmit} style={{
          display: 'flex',
          gap: '8px',
          padding: '8px',
          paddingTop: '0',
          alignItems: 'flex-start'
        }}>
          <textarea
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter SQL query... (Ctrl+Enter to run, Escape to close)"
            disabled={isLoading}
            rows={2}
            style={{
              flex: 1,
              padding: '6px 8px',
              backgroundColor: 'var(--vscode-input-background)',
              color: 'var(--vscode-input-foreground)',
              border: '1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent))',
              borderRadius: '3px',
              fontFamily: 'var(--vscode-editor-font-family)',
              fontSize: 'var(--vscode-editor-font-size)',
              resize: 'vertical',
              minHeight: '32px',
              outline: 'none'
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--vscode-focusBorder)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--vscode-input-border, var(--vscode-panel-border, transparent))';
            }}
          />
          <button
            type="submit"
            disabled={isLoading}
            style={{
              padding: '6px 12px',
              backgroundColor: 'var(--vscode-button-background)',
              color: 'var(--vscode-button-foreground)',
              border: 'none',
              borderRadius: '3px',
              cursor: isLoading ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--vscode-font-family)',
              fontSize: 'var(--vscode-font-size)',
              fontWeight: 500,
              opacity: isLoading ? 0.5 : 1,
              whiteSpace: 'nowrap'
            }}
            onMouseEnter={(e) => {
              if (!isLoading) {
                e.currentTarget.style.backgroundColor = 'var(--vscode-button-hoverBackground)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--vscode-button-background)';
            }}
          >
            {isLoading ? "Running..." : "Run"}
          </button>
        </form>
      )}
    </div>
  );
}
