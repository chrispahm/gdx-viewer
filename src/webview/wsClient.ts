/**
 * WebSocket client for communicating with GDX server
 */

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

export class GdxWebSocketClient {
  private ws: WebSocket | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private connectionPromise: Promise<void> | null = null;
  private documentId: string | null = null;

  async connect(port: number): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${port}`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.connectionPromise = null;
        resolve();
      };

      this.ws.onerror = (event) => {
        console.error('[GDX WebSocket] Error:', event);
        this.connectionPromise = null;
        reject(new Error('WebSocket connection failed'));
      };

      this.ws.onclose = () => {
        this.ws = null;
        this.connectionPromise = null;
      };

      this.ws.onmessage = (event) => {
        try {
          const response: ServerResponse = JSON.parse(event.data);

          const pending = this.pendingRequests.get(response.requestId);
          if (pending) {
            this.pendingRequests.delete(response.requestId);
            if (response.error) {
              pending.reject(new Error(response.error));
            } else {
              pending.resolve(response.result);
            }
          }
        } catch (e) {
          console.error('[GDX WebSocket] Failed to parse message:', e);
        }
      };
    });

    return this.connectionPromise;
  }

  setDocumentId(documentId: string): void {
    this.documentId = documentId;
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const requestId = `${++this.requestCounter}`;

    const request: ServerRequest = {
      type: 'request',
      requestId,
      method,
      params: {
        ...params,
        documentId: this.documentId,
      },
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.ws!.send(JSON.stringify(request));
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Global client instance
export const wsClient = new GdxWebSocketClient();
