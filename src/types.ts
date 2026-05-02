export type JsonRpcResponse = {
  id?: number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;
