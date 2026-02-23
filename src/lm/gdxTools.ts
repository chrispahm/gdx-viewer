import * as vscode from 'vscode';
import { GdxSymbol, QueryResult } from '../duckdb/duckdbService';
import { GdxServerClient } from '../server/gdxServerClient';

const TOOL_NAMES = {
	listSymbols: 'gdx_list_symbols',
	previewSymbol: 'gdx_preview_symbol',
	domainValues: 'gdx_domain_values',
	query: 'gdx_query',
	revealLocation: 'gdx_reveal_location',
} as const;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface ListSymbolsInput {
	source?: string;
}

interface PreviewSymbolInput {
	symbol: string;
	source?: string;
	limit?: number;
	offset?: number;
}

interface DomainValuesInput {
	symbol: string;
	dimIndex: number;
	source?: string;
	dimensionFilters?: Record<string, string[]>;
}

interface QueryInput {
	sql: string;
	source?: string;
	limit?: number;
	offset?: number;
}

interface RevealLocationInput {
	source?: string;
	symbol?: string;
	dimensionFilters?: Record<string, string | string[]>;
	targetColumn?: string;
	focusDimensions?: Record<string, string>;
}

interface OpenDocumentResult {
	symbols: GdxSymbol[];
}

interface DomainValuesResult {
	values: string[];
}

interface FormattedQueryResult {
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
	totalRowCount: number;
	truncated: boolean;
}

interface GdxToolDeps {
	getServerPort: () => number | null;
	getActiveSource: () => string | undefined;
	revealLocationInEditor: (input: RevealLocationInput) => Promise<unknown>;
}

class GdxToolRuntime {
	private client: GdxServerClient | null = null;
	private clientPort: number | null = null;

	constructor(private readonly deps: GdxToolDeps) {}

	async listSymbols(input: ListSymbolsInput): Promise<unknown> {
		const source = this.resolveSource(input.source);
		const documentId = this.toDocumentId(source);
		const openResult = await this.ensureDocumentOpen(documentId, source);

		return {
			source,
			symbolCount: openResult.symbols.length,
			symbols: openResult.symbols,
		};
	}

	async previewSymbol(input: PreviewSymbolInput): Promise<unknown> {
		if (!input.symbol?.trim()) {
			throw new Error('Missing required input: symbol');
		}

		const source = this.resolveSource(input.source);
		const documentId = this.toDocumentId(source);
		await this.ensureDocumentOpen(documentId, source);

		const limit = this.normalizeLimit(input.limit);
		const offset = this.normalizeOffset(input.offset);
		const escapedSymbol = this.escapeSqlString(input.symbol.trim());

		const sql = `SELECT * FROM read_gdx('__GDX_FILE__', '${escapedSymbol}') LIMIT ${limit} OFFSET ${offset}`;
		const queryResult = await this.executeQuery(documentId, sql);

		return {
			source,
			symbol: input.symbol,
			...this.formatResult(queryResult, limit, offset),
		};
	}

	async domainValues(input: DomainValuesInput): Promise<unknown> {
		if (!input.symbol?.trim()) {
			throw new Error('Missing required input: symbol');
		}
		if (!Number.isFinite(input.dimIndex) || input.dimIndex < 1) {
			throw new Error('Invalid input: dimIndex must be a 1-based number');
		}

		const source = this.resolveSource(input.source);
		const documentId = this.toDocumentId(source);
		await this.ensureDocumentOpen(documentId, source);

		const domainResult = await this.request<DomainValuesResult>('getDomainValues', {
			documentId,
			symbol: input.symbol,
			dimIndex: input.dimIndex,
			dimensionFilters: input.dimensionFilters,
		});

		const values = domainResult.values ?? [];
		return {
			source,
			symbol: input.symbol,
			dimIndex: input.dimIndex,
			count: values.length,
			values,
		};
	}

	async query(input: QueryInput): Promise<unknown> {
		if (!input.sql?.trim()) {
			throw new Error('Missing required input: sql');
		}

		const source = this.resolveSource(input.source);
		const documentId = this.toDocumentId(source);
		await this.ensureDocumentOpen(documentId, source);

		const queryResult = await this.executeQuery(documentId, input.sql);
		const limit = this.normalizeLimit(input.limit);
		const offset = this.normalizeOffset(input.offset);

		return {
			source,
			sql: input.sql,
			...this.formatResult(queryResult, limit, offset),
		};
	}

	async revealLocation(input: RevealLocationInput): Promise<unknown> {
		return this.deps.revealLocationInEditor(input);
	}

	dispose(): void {
		this.client?.dispose();
		this.client = null;
		this.clientPort = null;
	}

	private resolveSource(inputSource: string | undefined): string {
		if (inputSource?.trim()) {
			return inputSource.trim();
		}

		const activeSource = this.deps.getActiveSource();
		if (!activeSource) {
			throw new Error('No GDX source provided. Pass source or open a .gdx file and make it active in the editor.');
		}
		return activeSource;
	}

	private toDocumentId(source: string): string {
		return `lm:${source}`;
	}

	private normalizeLimit(value: number | undefined): number {
		if (!Number.isFinite(value)) {
			return DEFAULT_LIMIT;
		}
		return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value!)));
	}

	private normalizeOffset(value: number | undefined): number {
		if (!Number.isFinite(value)) {
			return 0;
		}
		return Math.max(0, Math.floor(value!));
	}

	private formatResult(result: QueryResult, limit: number, offset: number): FormattedQueryResult {
		const totalRows = result.rows.length;
		const rows = result.rows.slice(offset, offset + limit);
		const truncated = offset + rows.length < totalRows;

		return {
			columns: result.columns,
			rows,
			rowCount: rows.length,
			totalRowCount: totalRows,
			truncated,
		};
	}

	private escapeSqlString(value: string): string {
		return value.replace(/'/g, "''");
	}

	private async ensureDocumentOpen(documentId: string, source: string): Promise<OpenDocumentResult> {
		return this.request<OpenDocumentResult>('openDocument', { documentId, source });
	}

	private async executeQuery(documentId: string, sql: string): Promise<QueryResult> {
		return this.request<QueryResult>('executeQuery', { documentId, sql });
	}

	private async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
		const client = await this.getClient();
		return client.request<T>(method, params);
	}

	private async getClient(): Promise<GdxServerClient> {
		const port = this.deps.getServerPort();
		if (!port) {
			throw new Error('GDX server is not available.');
		}

		if (!this.client || this.clientPort !== port) {
			this.client?.dispose();
			this.client = new GdxServerClient(port);
			this.clientPort = port;
		}

		await this.client.connect();
		return this.client;
	}
}

function toToolResult(payload: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(JSON.stringify(payload, null, 2)),
	]);
}

function progressMessage(name: string, source: string | undefined): string {
	return source ? `${name} (${source})` : name;
}

export function registerGdxLanguageModelTools(context: vscode.ExtensionContext, deps: GdxToolDeps): void {
	const runtime = new GdxToolRuntime(deps);
	context.subscriptions.push({ dispose: () => runtime.dispose() });

	context.subscriptions.push(
		vscode.lm.registerTool<ListSymbolsInput>(TOOL_NAMES.listSymbols, {
			prepareInvocation: async (options) => ({
				invocationMessage: progressMessage('Listing GDX symbols', options.input.source),
			}),
			invoke: async (options, token) => {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}
				return toToolResult(await runtime.listSymbols(options.input));
			},
		})
	);

	context.subscriptions.push(
		vscode.lm.registerTool<PreviewSymbolInput>(TOOL_NAMES.previewSymbol, {
			prepareInvocation: async (options) => ({
				invocationMessage: progressMessage(`Previewing symbol ${options.input.symbol}`, options.input.source),
			}),
			invoke: async (options, token) => {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}
				return toToolResult(await runtime.previewSymbol(options.input));
			},
		})
	);

	context.subscriptions.push(
		vscode.lm.registerTool<DomainValuesInput>(TOOL_NAMES.domainValues, {
			prepareInvocation: async (options) => ({
				invocationMessage: progressMessage(`Loading domain values for ${options.input.symbol}`, options.input.source),
			}),
			invoke: async (options, token) => {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}
				return toToolResult(await runtime.domainValues(options.input));
			},
		})
	);

	context.subscriptions.push(
		vscode.lm.registerTool<QueryInput>(TOOL_NAMES.query, {
			prepareInvocation: async (options) => ({
				invocationMessage: progressMessage('Running GDX SQL query', options.input.source),
			}),
			invoke: async (options, token) => {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}
				return toToolResult(await runtime.query(options.input));
			},
		})
	);

	context.subscriptions.push(
		vscode.lm.registerTool<RevealLocationInput>(TOOL_NAMES.revealLocation, {
			prepareInvocation: async (options) => ({
				invocationMessage: progressMessage('Revealing location in GDX editor', options.input.source),
			}),
			invoke: async (options, token) => {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}
				return toToolResult(await runtime.revealLocation(options.input));
			},
		})
	);
}
