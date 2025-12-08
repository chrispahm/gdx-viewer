import * as vscode from 'vscode';
import { DuckdbService } from './duckdb/duckdbService';
import { GdxDocumentManager } from './duckdb/gdxDocumentManager';
import { GdxEditorProvider } from './providers/GdxEditorProvider';
import { GdxSymbolTreeProvider } from './providers/GdxSymbolTreeProvider';
import { GdxSymbol } from './duckdb/duckdbService';

let duckdbService: DuckdbService | null = null;
let documentManager: GdxDocumentManager | null = null;
let activeDocumentUri: vscode.Uri | null = null;

export async function activate(context: vscode.ExtensionContext) {
	console.log('GDX Viewer extension is activating...');

	try {
		// Initialize DuckDB service
		console.log('[GDX] Initializing DuckDB service...');
		duckdbService = new DuckdbService(context.extensionPath);
		await duckdbService.initialize();
		console.log('[GDX] DuckDB service initialized');

		// Create document manager
		documentManager = new GdxDocumentManager(duckdbService);

		// Create tree view provider
		const treeProvider = new GdxSymbolTreeProvider(documentManager);
		const treeView = vscode.window.createTreeView('gdxSymbols', {
			treeDataProvider: treeProvider,
		});

		// Create editor provider
		const editorProvider = new GdxEditorProvider(context, documentManager);

	// Track active document from editor provider
	editorProvider.onDidChangeActiveDocument((uri) => {
		activeDocumentUri = uri;
		if (uri) {
			const doc = documentManager?.getDocument(uri);
			treeProvider.setCurrentDocument(doc || null);
		} else {
			treeProvider.setCurrentDocument(null);
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
		{ dispose: () => documentManager?.dispose() },
		{ dispose: () => duckdbService?.dispose() }
	);

	console.log('GDX Viewer extension activated');
	} catch (error) {
		console.error('[GDX] Extension activation failed:', error);
		throw error;
	}
}

// This method is called when your extension is deactivated
export function deactivate() {}
