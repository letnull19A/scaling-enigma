import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  MasterToWorkerMessage,
  WorkerToMasterMessage,
} from '../../common/protocol';

type Subprocess = ReturnType<typeof Bun.spawn>;

interface PooledWorker {
  index: number;
  proc: Subprocess | null;
  pid: number | null;
  ready: boolean;
  busy: boolean;
  runsCompleted: number;
  currentRunId: string | null;
  readyResolve: (() => void) | null;
  readyReject: ((err: Error) => void) | null;
}

interface PendingTask {
  runId: string;
  workerIndex: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startedAt: number;
}

interface QueuedTask {
  runId: string;
  input: unknown;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * MASTER side only. Spawns N `bun src/worker.ts` processes via Bun.spawn IPC
 * and delegates all agent work to them. Master never runs agents itself.
 */
@Injectable()
export class WorkerPoolService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkerPoolService.name);

  private readonly poolSize = envInt('WORKER_POOL_SIZE', 2);
  private readonly maxRunsPerWorker = envInt('WORKER_MAX_RUNS_PER_WORKER', 50);
  private readonly taskTimeoutMs = envInt('WORKER_TASK_TIMEOUT_MS', 5 * 60 * 1000);
  private readonly memoryLimitMB = envInt('WORKER_MEMORY_LIMIT_MB', 512);
  private readonly maxQueue = envInt('WORKER_MAX_QUEUE', 100);
  private readonly startupTimeoutMs = envInt('WORKER_STARTUP_TIMEOUT_MS', 15_000);

  private workers: PooledWorker[] = [];
  private pending = new Map<string, PendingTask>();
  private queue: QueuedTask[] = [];
  private shuttingDown = false;

  async onModuleInit(): Promise<void> {
    this.logger.log(
      `Starting worker pool: size=${this.poolSize} maxRuns=${this.maxRunsPerWorker} ` +
        `timeout=${this.taskTimeoutMs}ms memLimit=${this.memoryLimitMB}MB`,
    );
    const starts = Array.from({ length: this.poolSize }, (_, i) => this.spawnWorker(i));
    await Promise.all(starts);
    this.logger.log(`Worker pool ready (${this.workers.length} workers)`);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const q of this.queue) {
      q.reject(new Error('server shutting down'));
    }
    this.queue.length = 0;
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('server shutting down'));
    }
    this.pending.clear();

    await Promise.all(
      this.workers.map(async (w) => {
        try {
          w.proc?.kill('SIGTERM');
        } catch {
          // ignore — process may already be gone
        }
      }),
    );
    // Give workers a moment to exit gracefully.
    await new Promise((r) => setTimeout(r, 500));
    for (const w of this.workers) {
      try {
        if (w.proc && w.proc.exitCode === null) w.proc.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
    this.workers = [];
  }

  /** Submit a run to the pool. Resolves with worker result, rejects on error/timeout. */
  submit(runId: string, input: unknown): Promise<unknown> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('pool is shutting down'));
    }
    return new Promise<unknown>((resolve, reject) => {
      const idle = this.workers.find((w) => w.ready && !w.busy && w.proc);
      if (idle) {
        this.dispatch(idle, runId, input, resolve, reject);
        return;
      }
      if (this.queue.length >= this.maxQueue) {
        reject(
          new ServiceUnavailableException(
            `worker queue full (${this.queue.length}/${this.maxQueue})`,
          ),
        );
        return;
      }
      this.queue.push({ runId, input, resolve, reject, enqueuedAt: Date.now() });
    });
  }

  /** Best-effort cancel: removes from queue or forwards to the owning worker. */
  cancel(runId: string): boolean {
    const qi = this.queue.findIndex((q) => q.runId === runId);
    if (qi >= 0) {
      const [q] = this.queue.splice(qi, 1);
      q.reject(new Error(`run ${runId} cancelled`));
      return true;
    }
    for (const w of this.workers) {
      if (w.currentRunId === runId && w.proc) {
        const msg: MasterToWorkerMessage = { kind: 'cancel', id: newId(), runId };
        try {
          w.proc.send(msg);
        } catch {
          // channel may be closed — pending timeout will clean up
        }
        return true;
      }
    }
    return false;
  }

  stats(): {
    poolSize: number;
    ready: number;
    busy: number;
    queued: number;
    pending: number;
  } {
    return {
      poolSize: this.workers.length,
      ready: this.workers.filter((w) => w.ready).length,
      busy: this.workers.filter((w) => w.busy).length,
      queued: this.queue.length,
      pending: this.pending.size,
    };
  }

  // ---- internals ----

  private spawnWorker(index: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const worker: PooledWorker = {
        index,
        proc: null,
        pid: null,
        ready: false,
        busy: false,
        runsCompleted: 0,
        currentRunId: null,
        readyResolve: null,
        readyReject: null,
      };

      const fail = (err: Error): void => {
        if (!worker.ready) reject(err);
      };
      worker.readyResolve = () => resolve();
      worker.readyReject = (err: Error) => fail(err);

      const startupTimer = setTimeout(() => {
        if (!worker.ready) {
          worker.readyReject?.(new Error(`worker#${index} startup timeout`));
          try {
            worker.proc?.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }, this.startupTimeoutMs);

      const existing = this.workers.findIndex((w) => w.index === index);
      if (existing >= 0) this.workers[existing] = worker;
      else this.workers.push(worker);

      const proc = Bun.spawn(['bun', 'src/worker.ts'], {
        env: { ...process.env, WORKER_INDEX: String(index) },
        stdio: ['inherit', 'inherit', 'inherit'],
        ipc: (message: unknown) => {
          this.handleMessage(index, message as WorkerToMasterMessage);
        },
        onExit: (_p, exitCode, signalCode) => {
          clearTimeout(startupTimer);
          this.handleExit(index, exitCode, signalCode);
        },
      });

      worker.proc = proc;
      worker.pid = proc.pid ?? null;
      this.logger.log(`worker#${index} spawned pid=${worker.pid}`);
    });
  }

  private handleExit(index: number, exitCode: number | null, signal: unknown): void {
    const w = this.workers.find((x) => x.index === index);
    this.logger.warn(`worker#${index} exited code=${exitCode} signal=${String(signal)}`);
    if (!w) return;

    // Fail its in-flight task, if any.
    if (w.currentRunId && this.pending.has(w.currentRunId)) {
      const p = this.pending.get(w.currentRunId)!;
      clearTimeout(p.timeout);
      p.reject(new Error(`worker#${index} died during run ${w.currentRunId}`));
      this.pending.delete(w.currentRunId);
    }
    w.ready = false;
    w.busy = false;
    w.currentRunId = null;
    w.proc = null;
    w.readyReject?.(new Error(`worker#${index} exited before ready`));
    w.readyResolve = null;
    w.readyReject = null;

    if (!this.shuttingDown) {
      setTimeout(() => {
        this.logger.log(`respawning worker#${index}...`);
        void this.spawnWorker(index).catch((err: unknown) =>
          this.logger.error(`respawn worker#${index} failed: ${String(err)}`),
        );
      }, 1000);
    }
  }

  private handleMessage(index: number, msg: WorkerToMasterMessage): void {
    const w = this.workers.find((x) => x.index === index);
    if (!w) return;

    switch (msg.kind) {
      case 'ready': {
        w.ready = true;
        this.logger.log(`worker#${index} ready`);
        w.readyResolve?.();
        w.readyResolve = null;
        w.readyReject = null;
        this.pumpQueue();
        break;
      }
      case 'started': {
        break; // tracking only; completion arrives via result/error
      }
      case 'progress': {
        // Progress is forwarded implicitly via RunRegistry polling in AgentsService.
        // Kept here for future SSE fan-out; no action needed to avoid log spam.
        break;
      }
      case 'result':
      case 'error': {
        const p = this.pending.get(msg.runId);
        if (!p) break; // stale (timed out / cancelled already)
        clearTimeout(p.timeout);
        this.pending.delete(msg.runId);
        w.busy = false;
        w.currentRunId = null;
        w.runsCompleted += 1;

        if (msg.kind === 'result') p.resolve(msg.result);
        else p.reject(new Error(msg.error));

        this.maybeRecycle(w, msg.memoryMB);
        this.pumpQueue();
        break;
      }
      case 'pong': {
        if (msg.memoryMB > this.memoryLimitMB && !w.busy) {
          this.logger.warn(
            `worker#${index} over memory ${msg.memoryMB}MB > ${this.memoryLimitMB}MB — recycling`,
          );
          this.recycle(w);
        }
        break;
      }
    }
  }

  private dispatch(
    w: PooledWorker,
    runId: string,
    input: unknown,
    resolve: (value: unknown) => void,
    reject: (err: Error) => void,
  ): void {
    w.busy = true;
    w.currentRunId = runId;
    const timeout = setTimeout(() => this.onTaskTimeout(runId), this.taskTimeoutMs);
    this.pending.set(runId, {
      runId,
      workerIndex: w.index,
      resolve,
      reject,
      timeout,
      startedAt: Date.now(),
    });
    const msg: MasterToWorkerMessage = { kind: 'run', id: runId, runId, input };
    try {
      w.proc?.send(msg);
    } catch (err) {
      clearTimeout(timeout);
      this.pending.delete(runId);
      w.busy = false;
      w.currentRunId = null;
      reject(err instanceof Error ? err : new Error(String(err)));
      this.pumpQueue();
    }
  }

  private pumpQueue(): void {
    while (this.queue.length > 0) {
      const idle = this.workers.find((w) => w.ready && !w.busy && w.proc);
      if (!idle) return;
      const task = this.queue.shift()!;
      this.dispatch(idle, task.runId, task.input, task.resolve, task.reject);
    }
  }

  private onTaskTimeout(runId: string): void {
    const p = this.pending.get(runId);
    if (!p) return;
    this.pending.delete(runId);
    p.reject(new Error(`run ${runId} timed out after ${this.taskTimeoutMs}ms`));
    const w = this.workers.find((x) => x.index === p.workerIndex);
    if (w) {
      // Hung task may have leaked state — kill the whole worker process.
      this.logger.warn(`run ${runId} timed out — recycling worker#${w.index}`);
      try {
        w.proc?.send({ kind: 'cancel', id: newId(), runId } satisfies MasterToWorkerMessage);
      } catch {
        // ignore
      }
      w.busy = false;
      w.currentRunId = null;
      this.recycle(w);
      this.pumpQueue();
    }
  }

  private maybeRecycle(w: PooledWorker, memoryMB?: number): void {
    if (w.runsCompleted >= this.maxRunsPerWorker) {
      this.logger.log(
        `worker#${w.index} reached ${w.runsCompleted} runs — recycling (anti-leak)`,
      );
      this.recycle(w);
      return;
    }
    if (memoryMB !== undefined && memoryMB > this.memoryLimitMB) {
      this.logger.warn(
        `worker#${w.index} memory ${memoryMB}MB > ${this.memoryLimitMB}MB — recycling`,
      );
      this.recycle(w);
    }
  }

  private recycle(w: PooledWorker): void {
    if (this.shuttingDown || w.busy) return;
    w.ready = false;
    try {
      w.proc?.kill('SIGTERM');
    } catch {
      // ignore
    }
    // onExit handler will respawn; force-kill fallback:
    setTimeout(() => {
      const cur = this.workers.find((x) => x.index === w.index);
      if (cur && cur.proc && cur.proc.exitCode === null && !cur.ready) {
        try {
          cur.proc.kill('SIGKILL');
        } catch {
          // ignore
        }
      }
    }, 3000);
    // If onExit didn't fire a respawn path (proc already dead), spawn now.
    setTimeout(() => {
      const cur = this.workers.find((x) => x.index === w.index);
      if (cur && !cur.proc && !this.shuttingDown) {
        void this.spawnWorker(w.index).catch((err: unknown) =>
          this.logger.error(`recycle respawn failed: ${String(err)}`),
        );
      }
    }, 3500);
  }
}
