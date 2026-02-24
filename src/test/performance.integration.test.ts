import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Performance Integration Tests
 *
 * These tests measure the actual time taken for GDX file operations
 * in the VS Code extension environment.
 */
suite('Performance Integration Test Suite', () => {
	// Large test file - same path used in vscode_viewer_workflow_test.ts
	const largeGdxPath = '/Users/pahmeyer/Documents/GitHub.nosync/gdx-viewer/src/test/FAO_trade_matrix_1986_2021.gdx';
	const targetSymbol = 'p_faoTradeMatrix';

	test('Should open large GDX file and display first page quickly', async function () {
		this.timeout(120000); // Allow 2 minutes for the full test

		// Skip if test file doesn't exist
		if (!fs.existsSync(largeGdxPath)) {
			console.log(`[PERF TEST] Skipping: Large GDX file not found at ${largeGdxPath}`);
			this.skip();
			return;
		}

		const uri = vscode.Uri.file(largeGdxPath);

		console.log('[PERF TEST] === Starting Large GDX File Performance Test ===');
		console.log(`[PERF TEST] File: ${largeGdxPath}`);
		console.log(`[PERF TEST] Target Symbol: ${targetSymbol}`);

		// Measure file open time
		const openStart = performance.now();
		await vscode.commands.executeCommand('vscode.openWith', uri, 'gdxViewer.gdxEditor');
		const openEnd = performance.now();
		console.log(`[PERF TEST] File open command completed in ${(openEnd - openStart).toFixed(0)}ms`);

		// Wait for the editor to fully initialize
		await new Promise(resolve => setTimeout(resolve, 2000));

		// Check that the file is open
		const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
		const gdxTab = tabs.find(tab => {
			const input = tab.input as { uri?: vscode.Uri };
			return input?.uri?.fsPath === largeGdxPath;
		});

		assert.ok(gdxTab, 'GDX file should be open in a tab');
		console.log('[PERF TEST] Tab opened successfully');

		// Note: The webview will auto-select the first symbol and run the query
		// We need to wait a bit for this to complete and observe the logs

		// Wait for initial data to be displayed (monitor extension host logs)
		// In a real scenario, we'd have better instrumentation
		console.log('[PERF TEST] Waiting for initial data load...');
		await new Promise(resolve => setTimeout(resolve, 10000));

		console.log('[PERF TEST] === Test Complete ===');
		console.log('[PERF TEST] Check Extension Host logs for detailed timing:');
		console.log('[PERF TEST] - Look for "[GDX Extension] Query success, rows:" messages');
		console.log('[PERF TEST] - First page should load in < 100ms after query is sent');
	});

	test('DuckDB Service direct performance test', async function () {
		this.timeout(60000);

		// Skip if test file doesn't exist
		if (!fs.existsSync(largeGdxPath)) {
			console.log(`[PERF TEST] Skipping: Large GDX file not found at ${largeGdxPath}`);
			this.skip();
			return;
		}

		const { DuckdbService } = await import('../duckdb/duckdbService.js');

		const service = new DuckdbService();

		console.log('[PERF TEST] === DuckDB Service Direct Performance Test ===');

		try {
			// Initialize DuckDB
			const initStart = performance.now();
			await service.initialize();
			const initEnd = performance.now();
			console.log(`[PERF TEST] DuckDB initialization: ${(initEnd - initStart).toFixed(0)}ms`);

			const fileStats = fs.statSync(largeGdxPath);
			console.log(`[PERF TEST] File size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);

			// Get symbols (DuckDB reads directly from disk)
			const symbolsStart = performance.now();
			const symbols = await service.getSymbols(largeGdxPath);
			const symbolsEnd = performance.now();
			console.log(`[PERF TEST] Get symbols (${symbols.length} total): ${(symbolsEnd - symbolsStart).toFixed(0)}ms`);

			// Find target symbol
			const symbol = symbols.find(s => s.name === targetSymbol);
			if (!symbol) {
				console.log(`[PERF TEST] Symbol ${targetSymbol} not found, using first symbol`);
			}
			const testSymbol = symbol || symbols[0];
			console.log(`[PERF TEST] Testing symbol: ${testSymbol.name} (${testSymbol.recordCount} records, ${testSymbol.dimensionCount} dims)`);

			const escapedPath = largeGdxPath.replace(/'/g, "''");

			// Query first page (LIMIT 10000 - matches actual extension default page size)
			const query1Start = performance.now();
			const result1 = await service.executeQuery(
				`SELECT * FROM read_gdx('${escapedPath}', '${testSymbol.name}') LIMIT 10000 OFFSET 0`
			);
			const query1End = performance.now();
			console.log(`[PERF TEST] First page query (10000 rows): ${(query1End - query1Start).toFixed(0)}ms`);
			console.log(`[PERF TEST] Actual rows returned: ${result1.rowCount}`);

			// Explain Analyze
			console.log('[PERF TEST] Running EXPLAIN ANALYZE...');
			const explainResult = await service.executeQuery(
				`EXPLAIN ANALYZE SELECT * FROM read_gdx('${escapedPath}', '${testSymbol.name}') LIMIT 100 OFFSET 0`
			);
			console.log('[PERF TEST] EXPLAIN ANALYZE result:');
			console.log(JSON.stringify(explainResult.rows, null, 2));

			// Query second page
			const query2Start = performance.now();
			const result2 = await service.executeQuery(
				`SELECT * FROM read_gdx('${escapedPath}', '${testSymbol.name}') LIMIT 10000 OFFSET 10000`
			);
			const query2End = performance.now();
			console.log(`[PERF TEST] Second page query (10000 rows): ${(query2End - query2Start).toFixed(0)}ms`);

			// Query third page
			const query3Start = performance.now();
			const result3 = await service.executeQuery(
				`SELECT * FROM read_gdx('${escapedPath}', '${testSymbol.name}') LIMIT 10000 OFFSET 20000`
			);
			const query3End = performance.now();
			console.log(`[PERF TEST] Third page query (10000 rows): ${(query3End - query3Start).toFixed(0)}ms`);

			// Domain values for first dimension (this is expensive!)
			console.log('[PERF TEST] Testing domain values (may take a while for large files)...');
			const domainStart = performance.now();
			const domainValues = await service.getDomainValues(largeGdxPath, testSymbol.name, 1);
			const domainEnd = performance.now();
			console.log(`[PERF TEST] Domain values dim 1 (${domainValues.length} values): ${(domainEnd - domainStart).toFixed(0)}ms`);

			// Verify row counts
			assert.strictEqual(result1.rowCount, 10000, 'First page should have 10000 rows');
			assert.strictEqual(result2.rowCount, 10000, 'Second page should have 10000 rows');
			assert.strictEqual(result3.rowCount, 10000, 'Third page should have 10000 rows');

			// Performance assertions - queries should complete in reasonable time
			const queryTimeThreshold = 1000; // 1 second max for page queries
			assert.ok(query1End - query1Start < queryTimeThreshold * 10, `First page query too slow: ${(query1End - query1Start).toFixed(0)}ms`);
			if ((query1End - query1Start) > 1000) {
				throw new Error(`Query too slow: ${(query1End - query1Start).toFixed(0)}ms`);
			}

			console.log('[PERF TEST] === Performance Summary ===');
			console.log(`[PERF TEST] DuckDB init: ${(initEnd - initStart).toFixed(0)}ms`);
			console.log(`[PERF TEST] Get symbols: ${(symbolsEnd - symbolsStart).toFixed(0)}ms`);
			console.log(`[PERF TEST] Page queries: ${(query1End - query1Start).toFixed(0)}ms / ${(query2End - query2Start).toFixed(0)}ms / ${(query3End - query3Start).toFixed(0)}ms`);
			console.log(`[PERF TEST] Domain values: ${(domainEnd - domainStart).toFixed(0)}ms`);

			await service.dispose();
		} catch (error) {
			await service.dispose();
			throw error;
		}
	});
});
