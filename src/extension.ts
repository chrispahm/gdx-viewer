import * as vscode from 'vscode';
import * as path from 'node:path';
import { stat } from 'node:fs/promises';
import { fork, ChildProcess } from 'node:child_process';
import { GdxEditorProvider } from './providers/GdxEditorProvider';
import { GdxSymbolTreeProvider } from './providers/GdxSymbolTreeProvider';
import { GdxSymbol } from './duckdb/duckdbService';
import { registerGdxLanguageModelTools } from './lm/gdxTools';

interface RevealLocationInput {
	source?: string;
	symbol?: string;
	dimensionFilters?: Record<string, string | string[]>;
	targetColumn?: string;
	focusDimensions?: Record<string, string>;
}

interface LocatorMessageFilter {
	columnName: string;
	filterValue: {
		selectedValues: string[];
	};
}

interface LocatorMessage {
	type: 'applyLocator';
	symbolName?: string;
	filters: LocatorMessageFilter[];
	targetColumn?: string;
	focusDimensions?: Record<string, string>;
}

let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;
let activeDocumentUri: vscode.Uri | null = null;

async function startServer(extensionPath: string, allowRemoteSourceLoading: boolean): Promise<number> {
	const serverPath = path.join(extensionPath, 'dist', 'server.js');

	try {
		await stat(serverPath);
	} catch {
		throw new Error(`Server entry not found at ${serverPath}. Please run npm run compile.`);
	}

	return new Promise((resolve, reject) => {
		const maxLogChars = 8000;
		let stdoutLog = '';
		let stderrLog = '';
		let settled = false;

		const appendRolling = (current: string, chunk: string): string => {
			const combined = current + chunk;
			return combined.length > maxLogChars ? combined.slice(-maxLogChars) : combined;
		};

		const diagnosticsOutput = (): string => {
			const safeStdout = stdoutLog.trim() || '(empty)';
			const safeStderr = stderrLog.trim() || '(empty)';
			return `
Child stdout:
${safeStdout}
Child stderr:
${safeStderr}`;
		};

		const rejectIfPending = (message: string): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(startupTimeout);
			reject(new Error(`${message}${diagnosticsOutput()}`));
		};

		// Use empty execArgv to prevent inheriting VS Code's debugger/inspector settings
		// which can cause conflicts with worker threads in the child process
		serverProcess = fork(serverPath, [extensionPath, JSON.stringify({ allowRemoteSourceLoading })], {
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
			execArgv: [], // Clear inherited node flags like --inspect
		});

		serverProcess.stdout?.on('data', (data: Buffer) => {
			const output = data.toString();
			stdoutLog = appendRolling(stdoutLog, output);
			console.log('[GDX Server]', output.trim());
		});

		serverProcess.stderr?.on('data', (data: Buffer) => {
			const output = data.toString();
			stderrLog = appendRolling(stderrLog, output);
			console.error('[GDX Server]', output.trim());
		});

		serverProcess.on('message', (msg: { type: string; port?: number }) => {
			if (msg.type === 'ready' && msg.port && !settled) {
				settled = true;
				clearTimeout(startupTimeout);
				resolve(msg.port);
			}
		});

		serverProcess.on('error', (err) => {
			console.error('[GDX] Server process error:', err);
			rejectIfPending(`Server process error before ready: ${err instanceof Error ? err.message : String(err)}\n`);
		});

		serverProcess.on('exit', (code, signal) => {
			serverProcess = null;
			serverPort = null;
			rejectIfPending(`Server process exited before ready (code: ${code ?? 'null'}, signal: ${signal ?? 'null'}).\n`);
		});

		const startupTimeout = setTimeout(() => {
			serverProcess?.kill();
			rejectIfPending('Server startup timeout: ready message was not received within 30000ms.\n');
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
					const symbols = editorProvider.getSymbolsForDocument(uri);
					console.log(`[GDX] Refreshed symbols for ${uri.fsPath}: ${symbols?.length ?? 0} symbols`);
					treeProvider.setSymbols(symbols || []);
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

		const revealLocationInEditor = async (input: RevealLocationInput): Promise<unknown> => {
			const source = input.source?.trim() || (
				activeDocumentUri
					? editorProvider.getFilePathForDocument(activeDocumentUri)
					: undefined
			);

			if (!source) {
				throw new Error('No GDX source provided. Pass source or open a .gdx file and make it active in the editor.');
			}

			if (/^https?:\/\//i.test(source)) {
				throw new Error('Reveal location only supports local .gdx files in the editor.');
			}

			const sourceUri = vscode.Uri.file(source);
			await vscode.commands.executeCommand('vscode.openWith', sourceUri, GdxEditorProvider.viewType);

			const filters: LocatorMessageFilter[] = [];
			if (input.dimensionFilters) {
				for (const [columnName, rawValues] of Object.entries(input.dimensionFilters)) {
					const values = Array.isArray(rawValues) ? rawValues : [rawValues];
					const selectedValues = values
						.map(value => String(value).trim())
						.filter(value => value.length > 0);
					if (columnName.trim() && selectedValues.length > 0) {
						filters.push({
							columnName: columnName.trim(),
							filterValue: { selectedValues },
						});
					}
				}
			}

			const focusDimensions = input.focusDimensions
				? Object.fromEntries(
					Object.entries(input.focusDimensions)
						.map(([key, value]) => [key.trim(), String(value).trim()])
						.filter(([key, value]) => key.length > 0 && value.length > 0)
				)
				: undefined;

			const locatorMessage: LocatorMessage = {
				type: 'applyLocator',
				symbolName: input.symbol?.trim() || undefined,
				filters,
				targetColumn: input.targetColumn?.trim() || undefined,
				focusDimensions,
			};

			editorProvider.applyLocatorInWebview(sourceUri, locatorMessage);

			return {
				source,
				symbol: locatorMessage.symbolName ?? null,
				filtersApplied: filters.length,
				highlightColumn: locatorMessage.targetColumn ?? null,
			};
		};

		const revealLocationCommand = vscode.commands.registerCommand(
			'gdxViewer.revealLocation',
			revealLocationInEditor
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
					revealLocationInEditor,
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
			revealLocationCommand,
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
