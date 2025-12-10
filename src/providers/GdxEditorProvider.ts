import * as vscode from 'vscode';
import { GdxDocumentManager, GdxDocumentState } from '../duckdb/gdxDocumentManager';
import { GdxSymbol } from '../duckdb/duckdbService';

interface GdxDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
  readonly state: GdxDocumentState;
}

class GdxDocumentImpl implements GdxDocument {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly state: GdxDocumentState,
    private readonly documentManager: GdxDocumentManager
  ) {}

  dispose(): void {
    // Close document in manager when custom document is disposed
    this.documentManager.closeDocument(this.uri);
  }
}

export class GdxEditorProvider implements vscode.CustomReadonlyEditorProvider<GdxDocument> {
  public static readonly viewType = 'gdxViewer.gdxEditor';

  private webviews = new Map<string, vscode.WebviewPanel>();
  private _onDidSelectSymbol = new vscode.EventEmitter<{ uri: vscode.Uri; symbol: GdxSymbol }>();
  private _onDidChangeActiveDocument = new vscode.EventEmitter<vscode.Uri | null>();
  readonly onDidSelectSymbol = this._onDidSelectSymbol.event;
  readonly onDidChangeActiveDocument = this._onDidChangeActiveDocument.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly documentManager: GdxDocumentManager
  ) {
    // Listen for filter loading changes to notify webviews
    documentManager.onFilterLoadingChanged(({ uri, isLoading }) => {
      const webview = this.webviews.get(uri.toString());
      if (webview) {
        webview.webview.postMessage({
          type: 'filterLoadingChanged',
          isLoading,
        });
      }
    });

    // Listen for domain values loaded to notify webviews
    documentManager.onDomainValuesLoaded(({ uri, columnName, values }) => {
      const webview = this.webviews.get(uri.toString());
      if (webview) {
        webview.webview.postMessage({
          type: 'domainValues',
          columnName,
          values,
        });
      }
    });
  }

  async openCustomDocument(uri: vscode.Uri): Promise<GdxDocument> {
    console.log('[GDX Extension] Opening custom document:', uri.toString());
    const bytes = await vscode.workspace.fs.readFile(uri);
    console.log('[GDX Extension] Read', bytes.length, 'bytes');
    const state = await this.documentManager.openDocument(uri, bytes);
    console.log('[GDX Extension] Document opened, symbols:', state.symbols.length);
    return new GdxDocumentImpl(uri, state, this.documentManager);
  }

  async resolveCustomEditor(
    document: GdxDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const uri = document.uri;
    this.webviews.set(uri.toString(), webviewPanel);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview'),
      ],
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

    // Handle messages from webview
    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      console.log('[GDX Extension] Received message from webview:', message.type);
      switch (message.type) {
        case 'ready':
          // Send initial data
          console.log('[GDX Extension] Sending init with', document.state.symbols.length, 'symbols');
          webviewPanel.webview.postMessage({
            type: 'init',
            symbols: document.state.symbols,
            isFilterLoading: document.state.isFilterLoading,
          });
          break;

        case 'executeQuery':
          console.log('[GDX Extension] Executing query:', message.sql);
          try {
            const result = await this.documentManager.executeQuery(uri, message.sql);
            console.log('[GDX Extension] Query success, rows:', result.rowCount);
            webviewPanel.webview.postMessage({
              type: 'queryResult',
              requestId: message.requestId,
              result,
            });
          } catch (error) {
            console.error('[GDX Extension] Query error:', error);
            webviewPanel.webview.postMessage({
              type: 'queryError',
              requestId: message.requestId,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
          break;

        case 'getDomainValues':
          try {
            const values = await this.documentManager.getDomainValues(
              uri,
              message.symbol,
              message.dimIndex
            );
            webviewPanel.webview.postMessage({
              type: 'domainValues',
              requestId: message.requestId,
              symbol: message.symbol,
              dimIndex: message.dimIndex,
              values,
            });
          } catch (error) {
            webviewPanel.webview.postMessage({
              type: 'domainValuesError',
              requestId: message.requestId,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
          break;

        case 'cancelFilterLoading':
          this.documentManager.cancelFilterLoading(uri);
          break;

        case 'startFilterLoading':
          // Start loading filters for specified symbol (called after data is displayed)
          const autoLoad = vscode.workspace.getConfiguration('gdxViewer').get<boolean>('autoLoadFilters', true);
          if (autoLoad) {
            this.documentManager.startFilterLoading(uri, message.symbol);
          }
          break;

        case 'selectSymbol':
          this._onDidSelectSymbol.fire({ uri, symbol: message.symbol });
          // Start loading filters for this symbol
          this.documentManager.startFilterLoading(uri, message.symbol.name);
          break;

        case 'exportData': {
          try {
            const format = message.format as 'csv' | 'parquet' | 'excel';
            const extension = format === 'excel' ? 'xlsx' : format;
            const suggested = uri.with({ path: uri.path.replace(/\.gdx$/i, `.${extension}`) });

            const target = await vscode.window.showSaveDialog({
              defaultUri: suggested,
              filters: {
                CSV: ['csv'],
                Excel: ['xlsx'],
                Parquet: ['parquet'],
              },
            });

            if (!target) {
              webviewPanel.webview.postMessage({
                type: 'exportError',
                requestId: message.requestId,
                error: 'Export cancelled',
              });
              break;
            }

            await this.documentManager.exportQuery(uri, message.query, format, target.fsPath);
            webviewPanel.webview.postMessage({
              type: 'exportResult',
              requestId: message.requestId,
              path: target.fsPath,
            });
            vscode.window.showInformationMessage(`Exported to ${target.fsPath}`);
          } catch (error) {
            webviewPanel.webview.postMessage({
              type: 'exportError',
              requestId: message.requestId,
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          }
          break;
        }
      }
    });

    webviewPanel.onDidDispose(() => {
      this.webviews.delete(uri.toString());
      this._onDidChangeActiveDocument.fire(null);
      // Hide symbols view when no GDX document is active
      if (this.webviews.size === 0) {
        vscode.commands.executeCommand('setContext', 'gdxViewer.hasActiveDocument', false);
      }
    });

    // Track when this panel becomes active/visible
    webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this._onDidChangeActiveDocument.fire(uri);
        vscode.commands.executeCommand('setContext', 'gdxViewer.hasActiveDocument', true);
      }
    });

    // Fire initial active document event and show symbols view
    this._onDidChangeActiveDocument.fire(uri);
    vscode.commands.executeCommand('setContext', 'gdxViewer.hasActiveDocument', true);

    // Focus the GDX Symbols view in the Explorer sidebar
    vscode.commands.executeCommand('gdxSymbols.focus');
  }

  selectSymbolInWebview(uri: vscode.Uri, symbol: GdxSymbol): void {
    const webview = this.webviews.get(uri.toString());
    if (webview) {
      webview.webview.postMessage({
        type: 'selectSymbol',
        symbol,
      });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview', 'index.css')
    );

    const nonce = getNonce();

    console.log('[GDX Extension] Webview script URI:', scriptUri.toString());
    console.log('[GDX Extension] Webview style URI:', styleUri.toString());

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>GDX Viewer</title>
</head>
<body class="vscode-dark">
  <div id="root"></div>
  <script nonce="${nonce}">
    console.log('[GDX Webview] HTML loaded, loading script...');
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
