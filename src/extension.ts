import * as vscode from 'vscode';
import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import { fork, ChildProcess } from 'node:child_process';
import { GdxEditorProvider } from './providers/GdxEditorProvider';
import { GdxSymbolTreeProvider } from './providers/GdxSymbolTreeProvider';
import { GdxSymbol } from './duckdb/duckdbService';
import { registerGdxLanguageModelTools } from './lm/gdxTools';

let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;
let activeDocumentUri: vscode.Uri | null = null;

async function startServer(extensionPath: string, allowRemoteSourceLoading: boolean): Promise<number> {
	return new Promise((resolve, reject) => {
		const serverPath = path.join(extensionPath, 'dist', 'server.js');

		// Use empty execArgv to prevent inheriting VS Code's debugger/inspector settings
		// which can cause conflicts with worker threads in the child process
		serverProcess = fork(serverPath, [extensionPath, JSON.stringify({ allowRemoteSourceLoading })], {
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
			execArgv: [], // Clear inherited node flags like --inspect
		});

		// Capture stdout for informational logs
		serverProcess.stdout?.on('data', (data: Buffer) => {
			console.log('[GDX Server]', data.toString().trim());
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
	const contributedTools = ((context.extension.packageJSON as {
		contributes?: { languageModelTools?: Array<{ name?: string }> };
	})?.contributes?.languageModelTools ?? []).map(tool => tool.name ?? '<unnamed>');
	console.log('[GDX] Contributed language model tools:', contributedTools.join(', '));

	try {
		const config = vscode.workspace.getConfiguration('gdxViewer');
		const allowRemoteSourceLoading = config.get<boolean>('allowRemoteSourceLoading', false);

		// Start server in child process (bypasses extension host limitations)
		console.log('[GDX] Starting GDX server...');
		serverPort = await startServer(context.extensionPath, allowRemoteSourceLoading);
		console.log(`[GDX] Server started on port ${serverPort}`);

		// Create tree view provider (minimal, no DuckDB access needed)
		const treeProvider = new GdxSymbolTreeProvider();
		const treeView = vscode.window.createTreeView('gdxSymbols', {
			treeDataProvider: treeProvider,
		});

		// Create editor provider with server port
		const editorProvider = new GdxEditorProvider(context, serverPort);

		const recentInternalSaves = new Map<string, number>();
		const pendingRefreshTimers = new Map<string, NodeJS.Timeout>();
		const lastObservedMtimeMs = new Map<string, number>();
		const INTERNAL_SAVE_WINDOW_MS = 1500;
		const FILE_CHANGE_DEBOUNCE_MS = 500;

		const queueRefreshForUri = (uri: vscode.Uri) => {
			const key = uri.toString();
			const now = Date.now();
			const lastInternalSave = recentInternalSaves.get(key);
			if (lastInternalSave && now - lastInternalSave < INTERNAL_SAVE_WINDOW_MS) {
				return;
			}

			if (!editorProvider.hasOpenDocument(uri)) {
				return;
			}

			const existingTimer = pendingRefreshTimers.get(key);
			if (existingTimer) {
				clearTimeout(existingTimer);
			}

			const timer = setTimeout(async () => {
				pendingRefreshTimers.delete(key);

				let mtimeMs: number | null = null;
				try {
					const fileStats = await stat(uri.fsPath);
					mtimeMs = fileStats.mtimeMs;
				} catch {
					// If file stats fail (e.g. transient access issue), fall back to notifying.
				}

				if (mtimeMs !== null) {
					const lastSeenMtime = lastObservedMtimeMs.get(key);
					if (lastSeenMtime !== undefined && mtimeMs <= lastSeenMtime) {
						return;
					}
					lastObservedMtimeMs.set(key, mtimeMs);
				}

				if (editorProvider.hasOpenDocument(uri)) {
					editorProvider.notifySourceFileChanged(uri);
				}
			}, FILE_CHANGE_DEBOUNCE_MS);

			pendingRefreshTimers.set(key, timer);
		};

		const saveSubscription = vscode.workspace.onDidSaveTextDocument((document) => {
			if (document.uri.fsPath.toLowerCase().endsWith('.gdx')) {
				recentInternalSaves.set(document.uri.toString(), Date.now());
			}
		});

		const gdxFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.gdx');
		gdxFileWatcher.onDidChange((uri) => queueRefreshForUri(uri));

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

		const lmApi = (vscode as unknown as { lm?: { tools?: ReadonlyArray<{ name: string }> } }).lm;
		if (lmApi) {
			try {
				registerGdxLanguageModelTools(context, {
					getServerPort: () => serverPort,
					getActiveSource: () => {
						if (!activeDocumentUri) {
							return undefined;
						}
						return editorProvider.getFilePathForDocument(activeDocumentUri);
					},
				});
				console.log('[GDX] Language model tools registered');
			} catch (error) {
				console.error('[GDX] Failed to register language model tools:', error);
			}
		} else {
			console.warn('[GDX] Language model tools API is unavailable in this VS Code build');
		}

		context.subscriptions.push(
			treeView,
			editorRegistration,
			selectSymbolCommand,
			saveSubscription,
			gdxFileWatcher,
			{
				dispose: () => {
					for (const timer of pendingRefreshTimers.values()) {
						clearTimeout(timer);
					}
					pendingRefreshTimers.clear();
					recentInternalSaves.clear();
					lastObservedMtimeMs.clear();
				},
			},
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
