import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import {
  ApprovalRespondParams,
  ApprovalResponse,
  ApprovalRequestedEvent,
  BindWorkspaceParams,
  ConversationCompletedEvent,
  ConversationDeltaEvent,
  ConversationDetailsParams,
  ConversationDetailsResponse,
  ConversationErrorEvent,
  ConversationKeyParams,
  ConversationRunningResponse,
  ConversationStatusResponse,
  CoreEvents,
  CoreMethods,
  DeliveryAckParams,
  DeliveryAckResponse,
  DeliveryListPendingResponse,
  JSONRPC_VERSION,
  JsonRpcFailure,
  JsonRpcNotification,
  JsonRpcSuccess,
  SendMessageParams,
  SendMessageResponse,
} from './core-protocol.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface CoreClientOptions {
  authToken?: string;
  requestTimeoutMs?: number;
}

export interface CoreClientEvents {
  [CoreEvents.delta]: (payload: ConversationDeltaEvent) => void;
  [CoreEvents.completed]: (payload: ConversationCompletedEvent) => void;
  [CoreEvents.error]: (payload: ConversationErrorEvent) => void;
  [CoreEvents.approvalRequested]: (payload: ApprovalRequestedEvent) => void;
}

export class CoreClient extends EventEmitter {
  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly url: string;
  private readonly authToken?: string;
  private readonly requestTimeoutMs: number;

  constructor(url: string, options: CoreClientOptions = {}) {
    super();
    this.url = url;
    this.authToken = options.authToken;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const headers = this.authToken
        ? {
            Authorization: `Bearer ${this.authToken}`,
            'X-Qodex-Token': this.authToken,
          }
        : undefined;
      const socket = new WebSocket(this.url, {
        headers,
        handshakeTimeout: this.requestTimeoutMs,
      });
      this.socket = socket;

      let settled = false;
      const finishConnect = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        this.connectPromise = undefined;
        if (error) {
          if (this.socket === socket && socket.readyState !== WebSocket.OPEN) {
            this.socket = undefined;
          }
          reject(error);
          return;
        }
        resolve();
      };

      socket.once('open', () => finishConnect());
      socket.once('error', (error) => finishConnect(error));
      socket.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        this.handleMessage(text);
      });
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = undefined;
        }
        this.connectPromise = undefined;
        this.rejectPendingRequests('core connection closed');
      });
      socket.on('error', () => {
        // The close handler clears pending requests and resets connection state.
      });
    });

    await this.connectPromise;
  }

  async sendMessage(params: SendMessageParams): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>(CoreMethods.sendMessage, params);
  }

  async bindWorkspace(params: BindWorkspaceParams): Promise<ConversationStatusResponse> {
    return this.request<ConversationStatusResponse>(CoreMethods.bindWorkspace, params);
  }

  async newThread(params: ConversationKeyParams): Promise<ConversationStatusResponse> {
    return this.request<ConversationStatusResponse>(CoreMethods.newThread, params);
  }

  async status(params: ConversationKeyParams): Promise<ConversationStatusResponse> {
    return this.request<ConversationStatusResponse>(CoreMethods.status, params);
  }

  async details(params: ConversationDetailsParams): Promise<ConversationDetailsResponse> {
    return this.request<ConversationDetailsResponse>(CoreMethods.details, params);
  }

  async running(params: ConversationKeyParams): Promise<ConversationRunningResponse> {
    return this.request<ConversationRunningResponse>(CoreMethods.running, params);
  }

  async listPendingDeliveries(): Promise<DeliveryListPendingResponse> {
    return this.request<DeliveryListPendingResponse>(CoreMethods.listPendingDeliveries, {});
  }

  async ackDelivery(params: DeliveryAckParams): Promise<DeliveryAckResponse> {
    return this.request<DeliveryAckResponse>(CoreMethods.ackDelivery, params);
  }

  async respondApproval(params: ApprovalRespondParams): Promise<ApprovalResponse> {
    return this.request<ApprovalResponse>(CoreMethods.respondApproval, params);
  }

  async ping(): Promise<{ pong: boolean }> {
    return this.request<{ pong: boolean }>(CoreMethods.ping, {});
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.socket = undefined;
      this.connectPromise = undefined;
      socket.once('close', () => resolve());
      socket.close();
    });
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      params,
    });

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `core request ${method} timed out after ${Math.round(this.requestTimeoutMs / 1000)}s`,
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error('core socket is not connected'));
        return;
      }
      socket.send(payload, (error) => {
        if (error) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private handleMessage(text: string): void {
    let payload:
      | JsonRpcSuccess
      | JsonRpcFailure
      | JsonRpcNotification;
    try {
      payload = JSON.parse(text) as JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;
    } catch (error) {
      this.rejectPendingRequests(
        `core returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.socket?.close();
      return;
    }

    if ('id' in payload && ('result' in payload || 'error' in payload)) {
      const request = this.pending.get(Number(payload.id));
      if (!request) {
        return;
      }
      this.pending.delete(Number(payload.id));
      if ('error' in payload) {
        request.reject(new Error(payload.error.message));
      } else {
        request.resolve(payload.result);
      }
      return;
    }

    if ('method' in payload) {
      this.emit(payload.method, payload.params);
    }
  }

  private rejectPendingRequests(message: string): void {
    for (const [id, request] of this.pending) {
      request.reject(new Error(`${message} before request ${id} completed`));
    }
    this.pending.clear();
  }
}
