import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { DuckdbService } from '../duckdb/duckdbService';

suite('DuckDB Service Test Suite', () => {
	let service: DuckdbService;
	const extensionPath = path.join(__dirname, '..', '..');
	const testGdxPath = path.join(__dirname, '..', '..', 'src', 'test', 'transport.gdx');

	suiteSetup(async function() {
		this.timeout(30000); // DuckDB initialization can take time
		service = new DuckdbService(extensionPath);
		await service.initialize();
	});

	suiteTeardown(async () => {
		await service.dispose();
	});

	test('Should initialize DuckDB service', () => {
		assert.ok(service, 'Service should be created');
	});

	test('Should register GDX file', async function() {
		this.timeout(10000);
		
		const bytes = fs.readFileSync(testGdxPath);
		const uint8Array = new Uint8Array(bytes);
		const uriString = `file://${testGdxPath}`;
		
		const registrationName = await service.registerGdxFile(uriString, uint8Array);
		assert.ok(registrationName, 'Should return registration name');
		assert.ok(registrationName.startsWith('gdx_'), 'Registration name should start with gdx_');
		assert.ok(registrationName.endsWith('.gdx'), 'Registration name should end with .gdx');
	});

	test('Should get symbols from GDX file', async function() {
		this.timeout(10000);
		
		const bytes = fs.readFileSync(testGdxPath);
		const uint8Array = new Uint8Array(bytes);
		const uriString = `file://${testGdxPath}`;
		
		const registrationName = await service.registerGdxFile(uriString, uint8Array);
		const symbols = await service.getSymbols(registrationName);
		
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
		
		const bytes = fs.readFileSync(testGdxPath);
		const uint8Array = new Uint8Array(bytes);
		const uriString = `file://${testGdxPath}`;
		
		const registrationName = await service.registerGdxFile(uriString, uint8Array);
		const symbols = await service.getSymbols(registrationName);
		
		// Find a symbol with records
		const symbolWithRecords = symbols.find(s => s.recordCount > 0);
		assert.ok(symbolWithRecords, 'Should have at least one symbol with records');
		
		const result = await service.executeQuery(
			`SELECT * FROM read_gdx('${registrationName}', '${symbolWithRecords!.name}') LIMIT 5`
		);
		
		assert.ok(result.columns, 'Result should have columns');
		assert.ok(Array.isArray(result.columns), 'Columns should be an array');
		assert.ok(result.rows, 'Result should have rows');
		assert.ok(Array.isArray(result.rows), 'Rows should be an array');
	});

	test('Should get domain values', async function() {
		this.timeout(30000); // First call can be slow
		
		const bytes = fs.readFileSync(testGdxPath);
		const uint8Array = new Uint8Array(bytes);
		const uriString = `file://${testGdxPath}`;
		
		const registrationName = await service.registerGdxFile(uriString, uint8Array);
		const symbols = await service.getSymbols(registrationName);
		
		// Find a symbol with dimensions
		const symbolWithDims = symbols.find(s => s.dimensionCount > 0 && s.recordCount > 0);
		if (symbolWithDims) {
			const values = await service.getDomainValues(
				registrationName,
				symbolWithDims.name,
				1
			);
			
			assert.ok(Array.isArray(values), 'Domain values should be an array');
		}
	});

	test('Should unregister file', async function() {
		this.timeout(10000);
		
		const bytes = fs.readFileSync(testGdxPath);
		const uint8Array = new Uint8Array(bytes);
		const uriString = `file://${testGdxPath}`;
		
		const registrationName = await service.registerGdxFile(uriString, uint8Array);
		await service.unregisterFile(registrationName);
		
		// Querying should fail after unregistering
		try {
			await service.getSymbols(registrationName);
			assert.fail('Should have thrown error after unregistering');
		} catch (error) {
			assert.ok(true, 'Should throw error for unregistered file');
		}
	});
});
