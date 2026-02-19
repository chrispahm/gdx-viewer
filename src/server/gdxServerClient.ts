import WebSocket from 'ws';

interface ServerRequest {
	type: 'request';
	requestId: string;
	method: string;
	params: Record<string, unknown>;
}

interface ServerResponse {
	type: 'response';
	requestId: string;
	result?: unknown;
	error?: string;
}

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
};

export class GdxServerClient {
	private ws: WebSocket | null = null;
	private pendingRequests = new Map<string, PendingRequest>();
	private requestCounter = 0;
	private connectionPromise: Promise<void> | null = null;

	constructor(private readonly port: number) {}

	async connect(): Promise<void> {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			return;
		}

		if (this.connectionPromise) {
			return this.connectionPromise;
		}

		this.connectionPromise = new Promise((resolve, reject) => {
			const url = `ws://127.0.0.1:${this.port}`;
			const ws = new WebSocket(url);
			this.ws = ws;

			ws.on('open', () => {
				this.connectionPromise = null;
				resolve();
			});

			ws.on('error', (event) => {
				this.connectionPromise = null;
				reject(new Error(`WebSocket connection failed: ${String(event)}`));
			});

			ws.on('close', () => {
				this.ws = null;
				this.connectionPromise = null;
				for (const pending of this.pendingRequests.values()) {
					pending.reject(new Error('WebSocket connection closed'));
				}
				this.pendingRequests.clear();
			});

			ws.on('message', (data) => {
				try {
					const response: ServerResponse = JSON.parse(data.toString());
					const pending = this.pendingRequests.get(response.requestId);
					if (!pending) {
						return;
					}

					this.pendingRequests.delete(response.requestId);
					if (response.error) {
						pending.reject(new Error(response.error));
					} else {
						pending.resolve(response.result);
					}
				} catch (error) {
					console.error('[GDX Server Client] Failed to parse message:', error);
				}
			});
		});

		return this.connectionPromise;
	}

	async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			await this.connect();
		}

		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('WebSocket not connected');
		}

		const requestId = `${++this.requestCounter}`;
		const request: ServerRequest = {
			type: 'request',
			requestId,
			method,
			params,
		};

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
			this.ws!.send(JSON.stringify(request));
		});
	}

	dispose(): void {
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this.connectionPromise = null;
	}
}
