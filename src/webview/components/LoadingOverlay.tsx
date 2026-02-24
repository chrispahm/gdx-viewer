type MaterializationStatus = 'idle' | 'preview' | 'materializing' | 'materialized';

interface MaterializationProgress {
  percentage: number;
  rowsProcessed: number;
  totalRows: number;
}

interface LoadingOverlayProps {
  isLoading: boolean;
  isFilterLoading: boolean;
  isRefreshing?: boolean;
  onCancelFilterLoading: () => void;
  materializationStatus?: MaterializationStatus;
  materializationProgress?: MaterializationProgress | null;
  onCancelMaterialization?: () => void;
}

const styles = {
  overlay: {
    position: 'absolute' as const,
    inset: 0,
    backgroundColor: 'var(--vscode-editor-background)',
    opacity: 0.9,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 50,
  },
  loadingContent: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  spinner: {
    width: '20px',
    height: '20px',
    border: '2px solid var(--vscode-descriptionForeground)',
    borderTopColor: 'var(--vscode-foreground)',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  filterBanner: {
    position: 'fixed' as const,
    bottom: '16px',
    right: '16px',
    backgroundColor: 'var(--vscode-editorWidget-background)',
    color: 'var(--vscode-foreground)',
    padding: '8px 16px',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    zIndex: 50,
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  refreshBanner: {
    position: 'fixed' as const,
    top: '16px',
    right: '16px',
    backgroundColor: 'var(--vscode-editorWidget-background)',
    color: 'var(--vscode-foreground)',
    padding: '8px 16px',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    zIndex: 50,
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  cancelButton: {
    padding: '2px 8px',
    backgroundColor: 'transparent',
    color: 'var(--vscode-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  materializationBanner: {
    position: 'fixed' as const,
    bottom: '16px',
    right: '16px',
    backgroundColor: 'var(--vscode-editorWidget-background)',
    color: 'var(--vscode-foreground)',
    padding: '10px 16px',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    zIndex: 50,
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
    minWidth: '220px',
  },
  materializationRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  progressBarOuter: {
    width: '100%',
    height: '4px',
    backgroundColor: 'var(--vscode-progressBar-background, var(--vscode-panel-border, #333))',
    borderRadius: '2px',
    overflow: 'hidden' as const,
  },
  progressBarInner: {
    height: '100%',
    backgroundColor: 'var(--vscode-progressBar-background, var(--vscode-focusBorder, #007acc))',
    borderRadius: '2px',
    transition: 'width 0.3s ease',
  },
};

export function LoadingOverlay({
  isLoading,
  isFilterLoading,
  isRefreshing = false,
  onCancelFilterLoading,
  materializationStatus = 'idle',
  materializationProgress,
  onCancelMaterialization,
}: LoadingOverlayProps) {
  const showMaterializationBanner = materializationStatus === 'preview' || materializationStatus === 'materializing';

  if (!isLoading && !isFilterLoading && !isRefreshing && !showMaterializationBanner) {
    return null;
  }

  const percentage = materializationProgress?.percentage ?? 0;
  const progressLabel = percentage > 0
    ? `Loading... ${Math.round(percentage)}%`
    : 'Loading...';

  return (
    <>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      {isLoading && (
        <div style={styles.overlay}>
          <div style={styles.loadingContent}>
            <div style={styles.spinner} />
            <span>Loading data...</span>
          </div>
        </div>
      )}
      {isFilterLoading && (
        <div style={styles.filterBanner}>
          <div style={styles.spinner} />
          <span>Loading filters...</span>
          <button
            style={styles.cancelButton}
            onClick={onCancelFilterLoading}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {isRefreshing && (
        <div style={styles.refreshBanner}>
          <div style={styles.spinner} />
          <span>Refreshing data...</span>
        </div>
      )}
      {showMaterializationBanner && !isLoading && (
        <div style={styles.materializationBanner}>
          <div style={styles.materializationRow}>
            <div style={styles.spinner} />
            <span style={{ flex: 1 }}>{progressLabel}</span>
            {onCancelMaterialization && (
              <button
                style={styles.cancelButton}
                onClick={onCancelMaterialization}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                Cancel
              </button>
            )}
          </div>
          <div style={styles.progressBarOuter}>
            <div style={{ ...styles.progressBarInner, width: `${Math.max(percentage, 2)}%` }} />
          </div>
        </div>
      )}
    </>
  );
}
