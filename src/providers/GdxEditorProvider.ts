import * as vscode from 'vscode';
import { GdxSymbol } from '../duckdb/duckdbService';

interface GdxDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
  readonly filePath: string;
  symbols: GdxSymbol[];
}

class GdxDocumentImpl implements GdxDocument {
  public symbols: GdxSymbol[] = [];

  constructor(
    public readonly uri: vscode.Uri,
    public readonly filePath: string
  ) { }

  dispose(): void {
    // Cleanup is handled via WebSocket
  }
}

export class GdxEditorProvider implements vscode.CustomReadonlyEditorProvider<GdxDocument> {
  public static readonly viewType = 'gdxViewer.gdxEditor';

  private webviews = new Map<string, vscode.WebviewPanel>();
  private documents = new Map<string, GdxDocumentImpl>();
  private _onDidSelectSymbol = new vscode.EventEmitter<{ uri: vscode.Uri; symbol: GdxSymbol }>();
  private _onDidChangeActiveDocument = new vscode.EventEmitter<vscode.Uri | null>();
  readonly onDidSelectSymbol = this._onDidSelectSymbol.event;
  readonly onDidChangeActiveDocument = this._onDidChangeActiveDocument.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly serverPort: number
  ) { }

  getSymbolsForDocument(uri: vscode.Uri): GdxSymbol[] | undefined {
    return this.documents.get(uri.toString())?.symbols;
  }

  async openCustomDocument(uri: vscode.Uri): Promise<GdxDocument> {
    console.log('[GDX Extension] Opening custom document:', uri.toString());
    const filePath = uri.fsPath;
    console.log('[GDX Extension] File path:', filePath);
    const doc = new GdxDocumentImpl(uri, filePath);
    this.documents.set(uri.toString(), doc);
    return doc;
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
          // Send init with server connection info and file path
          console.log('[GDX Extension] Sending init with server port', this.serverPort);
          webviewPanel.webview.postMessage({
            type: 'init',
            serverPort: this.serverPort,
            filePath: document.filePath,
            documentId: uri.toString(),
          });
          break;

        case 'symbolsLoaded':
          // Webview received symbols from server, store them for tree view
          const doc = this.documents.get(uri.toString());
          if (doc) {
            doc.symbols = message.symbols;
            this._onDidChangeActiveDocument.fire(uri);
          }
          break;

        case 'selectSymbol':
          this._onDidSelectSymbol.fire({ uri, symbol: message.symbol });
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

            // Send export path back to webview to handle via WebSocket
            webviewPanel.webview.postMessage({
              type: 'exportPath',
              requestId: message.requestId,
              path: target.fsPath,
              format,
            });
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
      this.documents.delete(uri.toString());
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

    // CSP needs to allow WebSocket connections to localhost
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src ws://127.0.0.1:* ws://localhost:*;">
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
