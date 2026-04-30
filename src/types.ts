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

export type ThreadRecord = {
  threadId: string;
  cwd: string;
  mode: "yolo";
  updatedAt: string;
};

export type StoreFile = {
  version: 1;
  projects: Record<string, ThreadRecord>;
};
