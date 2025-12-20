import * as vscode from 'vscode';
import * as path from 'node:path';
import { fork, ChildProcess } from 'node:child_process';
import { GdxEditorProvider } from './providers/GdxEditorProvider';
import { GdxSymbolTreeProvider } from './providers/GdxSymbolTreeProvider';
import { GdxSymbol } from './duckdb/duckdbService';

let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;
let activeDocumentUri: vscode.Uri | null = null;

async function startServer(extensionPath: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const serverPath = path.join(extensionPath, 'dist', 'server.js');

		// Use empty execArgv to prevent inheriting VS Code's debugger/inspector settings
		// which can cause conflicts with worker threads in the child process
		serverProcess = fork(serverPath, [extensionPath], {
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
			execArgv: [], // Clear inherited node flags like --inspect
		});

		// Capture stderr for error logging
		serverProcess.stderr?.on('data', (data: Buffer) => {
			console.error('[GDX Server]', data.toString().trim());
		});

		serverProcess.on('message', (msg: { type: string; port?: number }) => {
			if (msg.type === 'ready' && msg.port) {
				resolve(msg.port);
			}
		});

		serverProcess.on('error', (err) => {
			console.error('[GDX] Server process error:', err);
			reject(err);
		});

		serverProcess.on('exit', (code) => {
			serverProcess = null;
			serverPort = null;
		});

		// Timeout after 30 seconds
		setTimeout(() => {
			if (!serverPort) {
				serverProcess?.kill();
				reject(new Error('Server startup timeout'));
			}
		}, 30000);
	});
}

function stopServer(): void {
	if (serverProcess) {
		serverProcess.kill('SIGTERM');
		serverProcess = null;
		serverPort = null;
	}
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('GDX Viewer extension is activating...');

	try {
		// Start server in child process (bypasses extension host limitations)
		console.log('[GDX] Starting GDX server...');
		serverPort = await startServer(context.extensionPath);
		console.log(`[GDX] Server started on port ${serverPort}`);

		// Create tree view provider (minimal, no DuckDB access needed)
		const treeProvider = new GdxSymbolTreeProvider();
		const treeView = vscode.window.createTreeView('gdxSymbols', {
			treeDataProvider: treeProvider,
		});

		// Create editor provider with server port
		const editorProvider = new GdxEditorProvider(context, serverPort);

		// Track active document from editor provider
		editorProvider.onDidChangeActiveDocument((uri) => {
			activeDocumentUri = uri;
			if (uri) {
				const symbols = editorProvider.getSymbolsForDocument(uri);
				treeProvider.setSymbols(symbols || []);
			} else {
				treeProvider.setSymbols([]);
			}
		});

		// Register custom editor
		const editorRegistration = vscode.window.registerCustomEditorProvider(
			GdxEditorProvider.viewType,
			editorProvider,
			{
				webviewOptions: { retainContextWhenHidden: true },
			}
		);

		// Register select symbol command - called from tree view
		const selectSymbolCommand = vscode.commands.registerCommand(
			'gdxViewer.selectSymbol',
			(symbol: GdxSymbol) => {
				if (activeDocumentUri) {
					editorProvider.selectSymbolInWebview(activeDocumentUri, symbol);
				}
			}
		);

		context.subscriptions.push(
			treeView,
			editorRegistration,
			selectSymbolCommand,
			{ dispose: () => stopServer() }
		);

		console.log('GDX Viewer extension activated');
	} catch (error) {
		console.error('[GDX] Extension activation failed:', error);
		throw error;
	}
}

// This method is called when your extension is deactivated
export function deactivate() {
	stopServer();
}
