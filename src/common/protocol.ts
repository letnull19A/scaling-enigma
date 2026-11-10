export type MasterToWorkerMessage =
  | { kind: 'run'; id: string; runId: string; input: unknown }
  | { kind: 'cancel'; id: string; runId: string }
  | { kind: 'ping'; id: string };

export type WorkerToMasterMessage =
  | { kind: 'ready' }
  | { kind: 'started'; id: string; runId: string }
  | { kind: 'progress'; id: string; runId: string; progress: number; message?: string }
  | { kind: 'result'; id: string; runId: string; result: unknown; memoryMB?: number }
  | { kind: 'error'; id: string; runId: string; error: string; memoryMB?: number }
  | { kind: 'pong'; id: string; memoryMB: number };

export function currentMemoryMB(): number {
  const rss = process.memoryUsage().rss;
  return Math.round((rss / 1024 / 1024) * 10) / 10;
}
