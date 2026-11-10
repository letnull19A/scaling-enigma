import { Injectable, Logger } from '@nestjs/common';
import type { AgentRunInput } from '../agent-execution/agent-runner.service';
import { WorkerPoolService } from '../runtime/worker-pool.service';

export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface AgentRunRecord {
  runId: string;
  status: RunStatus;
  input: AgentRunInput;
  progress: number;
  message?: string;
  result?: unknown;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Master-side registry. Holds only metadata (no agent state),
 * so memory is bounded and entries are explicitly finalized.
 */
@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly maxRecords = 1000;

  constructor(private readonly pool: WorkerPoolService) {}

  async create(input: AgentRunInput): Promise<AgentRunRecord> {
    const runId = newRunId();
    const record: AgentRunRecord = {
      runId,
      status: 'running',
      input,
      progress: 0,
      createdAt: Date.now(),
    };
    this.runs.set(runId, record);
    this.evictIfNeeded();

    // Fire-and-forget against the pool: HTTP returns immediately,
    // completion lands in the registry via promise callbacks.
    this.pool
      .submit(runId, input)
      .then((result) => {
        record.status = 'done';
        record.progress = 100;
        record.result = result;
        record.finishedAt = Date.now();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const lower = message.toLowerCase();
        if (record.status === 'cancelled') {
          record.error = message;
          return;
        }
        if (lower.includes('cancel') || lower.includes('abort')) record.status = 'cancelled';
        else record.status = 'failed';
        record.error = message;
        record.finishedAt = Date.now();
        this.logger.warn(`[${runId}] ${record.status}: ${message}`);
      });

    return record;
  }

  get(runId: string): AgentRunRecord | undefined {
    return this.runs.get(runId);
  }

  list(): AgentRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
  }

  cancel(runId: string): boolean {
    const record = this.runs.get(runId);
    if (!record || record.finishedAt) return false;
    const ok = this.pool.cancel(runId);
    if (ok) {
      record.status = 'cancelled';
      record.finishedAt = Date.now();
    }
    return ok;
  }

  poolStats(): ReturnType<WorkerPoolService['stats']> {
    return this.pool.stats();
  }

  private evictIfNeeded(): void {
    if (this.runs.size <= this.maxRecords) return;
    const finished = [...this.runs.values()]
      .filter((r) => r.finishedAt)
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    const overflow = this.runs.size - this.maxRecords;
    for (let i = 0; i < overflow && i < finished.length; i += 1) {
      this.runs.delete(finished[i].runId);
    }
  }
}
