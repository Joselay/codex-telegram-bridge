export type JsonRpcRequest = {
  method: string;
  id?: number;
  params?: unknown;
};

export type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;
