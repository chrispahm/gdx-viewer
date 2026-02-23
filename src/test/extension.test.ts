import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	const testGdxPath = path.join(__dirname, '..', '..', 'src', 'test', 'transport.gdx');
	const extension = vscode.extensions.getExtension('chrispahm.gdx-viewer')
		?? vscode.extensions.all.find(ext => ext.packageJSON?.name === 'gdx-viewer');

	test('Extension should be present', () => {
		assert.ok(extension, 'Extension should be installed');
	});

	test('Should register custom editor for .gdx files', async () => {
		// Check that the custom editor is registered
		const customEditors = vscode.extensions.all
			.filter(ext => ext.packageJSON?.contributes?.customEditors)
			.flatMap(ext => ext.packageJSON.contributes.customEditors);
		
		const gdxEditor = customEditors.find(
			(editor: { viewType: string }) => editor.viewType === 'gdxViewer.gdxEditor'
		);
		assert.ok(gdxEditor, 'GDX custom editor should be registered');
	});

	test('Should register tree view', () => {
		// The tree view should be registered under the explorer view
		const views = extension?.packageJSON?.contributes?.views;
		// Check that the explorer array contains the gdxSymbols view
		const explorerViews = views?.explorer;
		assert.ok(Array.isArray(explorerViews), 'Explorer views should be an array');
		const gdxSymbolsView = explorerViews?.find((v: { id: string }) => v.id === 'gdxSymbols');
		assert.ok(gdxSymbolsView, 'GDX Symbols view should be in explorer sidebar');
	});

	test('Should have configuration setting for autoLoadFilters', () => {
		const config = vscode.workspace.getConfiguration('gdxViewer');
		const autoLoadFilters = config.get<boolean>('autoLoadFilters');
		assert.strictEqual(autoLoadFilters, true, 'autoLoadFilters should default to true');
	});

	test('Should have configuration setting for allowRemoteSourceLoading', () => {
		const config = vscode.workspace.getConfiguration('gdxViewer');
		const allowRemoteSourceLoading = config.get<boolean>('allowRemoteSourceLoading');
		assert.strictEqual(allowRemoteSourceLoading, false, 'allowRemoteSourceLoading should default to false');
	});

	test('Test GDX file should exist', async () => {
		const uri = vscode.Uri.file(testGdxPath);
		try {
			await vscode.workspace.fs.stat(uri);
			assert.ok(true, 'transport.gdx file exists');
		} catch {
			assert.fail('transport.gdx file should exist in src/test/');
		}
	});
});

suite('Integration Test Suite', () => {
	const testGdxPath = path.join(__dirname, '..', '..', 'src', 'test', 'transport.gdx');

	test('Test GDX file should be readable', () => {
		assert.ok(fs.existsSync(testGdxPath), 'transport.gdx should exist');
		const stats = fs.statSync(testGdxPath);
		assert.ok(stats.size > 0, 'transport.gdx should not be empty');
	});

	test('Should open GDX file with custom editor', async function() {
		this.timeout(30000); // Allow 30 seconds for DuckDB initialization
		
		const uri = vscode.Uri.file(testGdxPath);
		
		// Open the file with our custom editor
		await vscode.commands.executeCommand('vscode.openWith', uri, 'gdxViewer.gdxEditor');
		
		// Wait a bit for the editor to initialize
		await new Promise(resolve => setTimeout(resolve, 5000));
		
		// Check that a tab is open
		const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
		const gdxTab = tabs.find(tab => {
			const input = tab.input as { uri?: vscode.Uri };
			return input?.uri?.fsPath === testGdxPath;
		});
		
		assert.ok(gdxTab, 'GDX file should be open in a tab');
	});

	test('DuckDB service should initialize and load GDX extension', async function() {
		this.timeout(30000);
		
		// Import DuckdbService directly for testing
		const { DuckdbService } = await import('../duckdb/duckdbService.js');
		
		const extensionPath = path.join(__dirname, '..', '..');
		const service = new DuckdbService(extensionPath);
		
		try {
			await service.initialize();
			
			// Register the test GDX file
			const fileBytes = fs.readFileSync(testGdxPath);
			const registrationName = await service.registerGdxFile(testGdxPath, new Uint8Array(fileBytes));
			
			assert.ok(registrationName, 'Should return a registration name');
			assert.ok(registrationName.endsWith('.gdx'), 'Registration name should end with .gdx');
			
			// Get symbols from the file
			const symbols = await service.getSymbols(registrationName);
			
			assert.ok(Array.isArray(symbols), 'Should return an array of symbols');
			assert.ok(symbols.length > 0, 'transport.gdx should have at least one symbol');
			
			// Each symbol should have the required properties
			for (const symbol of symbols) {
				assert.ok(typeof symbol.name === 'string', 'Symbol should have a name');
				assert.ok(typeof symbol.type === 'string', 'Symbol should have a type');
				assert.ok(typeof symbol.dimensionCount === 'number', 'Symbol should have dimensionCount');
				assert.ok(typeof symbol.recordCount === 'number', 'Symbol should have recordCount');
			}
			
			// Execute a query on the first symbol
			if (symbols.length > 0) {
				const result = await service.executeQuery(
					`SELECT * FROM read_gdx('${registrationName}', '${symbols[0].name}') LIMIT 10`
				);
				
				assert.ok(result, 'Query should return a result');
				assert.ok(Array.isArray(result.columns), 'Result should have columns');
				assert.ok(Array.isArray(result.rows), 'Result should have rows');
				assert.ok(typeof result.rowCount === 'number', 'Result should have rowCount');
			}
			
			// Clean up
			await service.unregisterFile(registrationName);
			await service.dispose();
		} catch (error) {
			await service.dispose();
			throw error;
		}
	});

	test('Should get distinct values for filtering', async function() {
		this.timeout(30000);
		
		const { DuckdbService } = await import('../duckdb/duckdbService.js');
		
		const extensionPath = path.join(__dirname, '..', '..');
		const service = new DuckdbService(extensionPath);
		
		try {
			await service.initialize();
			
			const fileBytes = fs.readFileSync(testGdxPath);
			const registrationName = await service.registerGdxFile(testGdxPath, new Uint8Array(fileBytes));
			
			const symbols = await service.getSymbols(registrationName);
			
			// Find a symbol with at least one dimension
			const symbolWithDimensions = symbols.find((s: { dimensionCount: number }) => s.dimensionCount > 0);
			
			if (symbolWithDimensions) {
				const distinctValues = await service.getDomainValues(
					registrationName,
					symbolWithDimensions.name,
					1 // First dimension (1-indexed in GDX)
				);
				
				assert.ok(Array.isArray(distinctValues), 'Should return array of distinct values');
			}
			
			await service.unregisterFile(registrationName);
			await service.dispose();
		} catch (error) {
			await service.dispose();
			throw error;
		}
	});
});
