import * as assert from 'assert';
import * as path from 'path';
import { DuckdbService } from '../duckdb/duckdbService';

suite('DuckDB Service Test Suite', () => {
	let service: DuckdbService;
	const testGdxPath = path.join(__dirname, '..', '..', 'src', 'test', 'transport.gdx');

	suiteSetup(async function() {
		this.timeout(30000); // DuckDB initialization can take time
		service = new DuckdbService();
		await service.initialize();
	});

	suiteTeardown(async () => {
		await service.dispose();
	});

	test('Should initialize DuckDB service', () => {
		assert.ok(service, 'Service should be created');
	});

	test('Should register local file path', async function() {
		this.timeout(10000);

		const filePath = await service.registerFile(testGdxPath);
		assert.strictEqual(filePath, testGdxPath, 'Local file should return the path directly');
	});

	test('Should get symbols from GDX file', async function() {
		this.timeout(10000);

		const symbols = await service.getSymbols(testGdxPath);

		assert.ok(Array.isArray(symbols), 'Symbols should be an array');
		assert.ok(symbols.length > 0, 'Should have at least one symbol');

		// Check symbol structure
		const firstSymbol = symbols[0];
		assert.ok(typeof firstSymbol.name === 'string', `Symbol should have name, got: ${JSON.stringify(firstSymbol)}`);
		assert.ok(typeof firstSymbol.type === 'string', `Symbol should have type, got: ${JSON.stringify(firstSymbol)}`);
		assert.ok(typeof firstSymbol.dimensionCount === 'number' || firstSymbol.dimensionCount === null, `Symbol should have dimensionCount, got: ${JSON.stringify(firstSymbol)}`);
		assert.ok(typeof firstSymbol.recordCount === 'number' || firstSymbol.recordCount === null, `Symbol should have recordCount, got: ${JSON.stringify(firstSymbol)}`);
	});

	test('Should execute SQL query', async function() {
		this.timeout(10000);

		const symbols = await service.getSymbols(testGdxPath);

		// Find a symbol with records
		const symbolWithRecords = symbols.find(s => s.recordCount > 0);
		assert.ok(symbolWithRecords, 'Should have at least one symbol with records');

		const escapedPath = testGdxPath.replace(/'/g, "''");
		const result = await service.executeQuery(
			`SELECT * FROM read_gdx('${escapedPath}', '${symbolWithRecords!.name}') LIMIT 5`
		);

		assert.ok(result.columns, 'Result should have columns');
		assert.ok(Array.isArray(result.columns), 'Columns should be an array');
		assert.ok(result.rows, 'Result should have rows');
		assert.ok(Array.isArray(result.rows), 'Rows should be an array');
	});

	test('Should get domain values', async function() {
		this.timeout(30000); // First call can be slow

		const symbols = await service.getSymbols(testGdxPath);

		// Find a symbol with dimensions
		const symbolWithDims = symbols.find(s => s.dimensionCount > 0 && s.recordCount > 0);
		if (symbolWithDims) {
			const values = await service.getDomainValues(
				testGdxPath,
				symbolWithDims.name,
				1
			);

			assert.ok(Array.isArray(values), 'Domain values should be an array');
		}
	});

	test('Should reinitialize and return same symbols', async function() {
		this.timeout(30000);

		const symbolsBefore = await service.getSymbols(testGdxPath);
		assert.ok(symbolsBefore.length > 0, 'Should have symbols before reinitialize');

		await service.reinitialize();

		const symbolsAfter = await service.getSymbols(testGdxPath);
		assert.strictEqual(symbolsAfter.length, symbolsBefore.length, 'Should have same number of symbols after reinitialize');
		assert.deepStrictEqual(
			symbolsAfter.map(s => s.name),
			symbolsBefore.map(s => s.name),
			'Symbol names should match after reinitialize'
		);
	});

	test('Should handle unregister for local file (no-op)', async function() {
		this.timeout(10000);

		// Unregistering a local file is a no-op — DuckDB reads from disk directly
		await service.unregisterFile(testGdxPath);

		// File should still be queryable since it exists on disk
		const symbols = await service.getSymbols(testGdxPath);
		assert.ok(symbols.length > 0, 'File should still be queryable after unregister');
	});
});
