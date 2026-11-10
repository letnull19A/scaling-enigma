# nestjs-workers

Modular monolith on **NestJS 12 + Bun + TypeScript 7** with a **master/worker** runtime on pure Bun IPC. No Redis, no microservices.

The master process serves HTTP and manages a pool of worker processes. Workers execute AI-agent (and workflow) runs. The master never runs agents itself — it only delegates.

## Requirements

- Bun >= 1.1.0 (`bun --version`)
- TypeScript 7 (`bunx tsc --version` → `7.0.x`)
- NestJS 12 (`@nestjs/*@12.4.x`)

## Quick start

```bash
bun install
bun run start:dev
```

App: http://localhost:3000

- `GET /` — Hello World
- `GET /health` — `{ "status": "ok" }`
- `POST /agents/runs` — submit an agent run (returns `202 { runId }` immediately)
- `GET /agents/runs/:id` — run status / result
- `GET /agents/runs` — recent runs + pool stats
- `DELETE /agents/runs/:id` — cancel a run
- `GET /agents/pool` — worker pool stats

## Architecture

```
              ┌──────────────────────── MASTER (src/main.ts) ────────────────────────┐
              │  HTTP (AppModule)                                                     │
              │    AppController (/health)                                            │
              │    AgentsModule: AgentsController → AgentsService (RunRegistry)       │
              │                        │ submit(runId, input) / cancel(runId)         │
              │    RuntimeModule: WorkerPoolService (Bun.spawn IPC pool manager)      │
              └──────────────────────────┬──────────────────────┬────────────────────┘
                         Bun.spawn IPC   │                      │  Bun.spawn IPC
                    {run/cancel/ping}    │                      │  {run/cancel/ping}
                                         ▼                      ▼
                              ┌──────────────────┐   ┌──────────────────┐
                              │ WORKER #0        │   │ WORKER #1        │  ...
                              │ src/worker.ts    │   │ src/worker.ts    │
                              │ AgentExecution-  │   │ AgentExecution-  │
                              │ Module only      │   │ Module only      │
                              │ (no HTTP)        │   │ (no HTTP)        │
                              └──────────────────┘   └──────────────────┘
```

**Separation of concerns:**

| Process | Entrypoint | Nest context | Responsibility |
|---|---|---|---|
| Master | `src/main.ts` | `AppModule` (HTTP + `AgentsModule` + `RuntimeModule`) | Accept HTTP, keep `RunRegistry` metadata, manage pool, never executes agents |
| Worker | `src/worker.ts` | `AgentExecutionModule` only | Execute `AgentRunnerService.run()`, report progress/result, handle cancel |

IPC uses `Bun.spawn(["bun", "src/worker.ts"], { ipc })` on the master side and `process.send()` / `process.on("message")` on the worker side (same API as Node `child_process.fork`). Default serialization is `advanced` (structured-clone).

## How it works

1. `POST /agents/runs { prompt, steps?, stepDelayMs? }` creates a `runId`, stores a `queued/running` record in `AgentsService` (metadata only), and calls `WorkerPoolService.submit(runId, input)`.
2. The pool dispatches to an idle `ready` worker via IPC `{ kind: 'run', id: runId, runId, input }`. If all workers are busy, the task waits in a bounded in-memory queue (`WORKER_MAX_QUEUE`, default 100). Overflow returns `429`.
3. The worker runs `AgentRunnerService.run()` with a per-run `AbortController`, streams `{ kind: 'progress' }` messages, and finishes with `{ kind: 'result' }` or `{ kind: 'error' }` (including `memoryMB`).
4. The pool resolves the pending promise, marks the worker idle, and `AgentsService` flips the record to `done`/`failed`/`cancelled`. HTTP polling (`GET /agents/runs/:id`) observes completion — the request thread is never blocked.
5. `DELETE /agents/runs/:id` removes the task from the queue or forwards `{ kind: 'cancel' }` to the owning worker, which aborts via `AbortController`.

### Anti-leak / pool hygiene

- **Bounded everything:** fixed `WORKER_POOL_SIZE`, bounded queue, `maxRecords=1000` registry with eviction of finished runs.
- **No cross-run state:** each run gets a fresh context; intermediate buffers are cleared in `finally`; `sleep()` removes its abort listener.
- **Recycling:** a worker is killed and respawned after `WORKER_MAX_RUNS_PER_WORKER` runs (default 50), when reported `memoryMB > WORKER_MEMORY_LIMIT_MB` (default 512), or after a task timeout (hung state is assumed leaked).
- **Timeouts:** per-task `WORKER_TASK_TIMEOUT_MS` (default 5 min) rejects the caller, sends `cancel`, and recycles the worker. Startup has its own `WORKER_STARTUP_TIMEOUT_MS` (default 15 s).
- **Shutdown:** `onModuleDestroy` drains the queue, rejects pending with `server shutting down`, `SIGTERM`s workers, then `SIGKILL`s stragglers.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Master HTTP port |
| `WORKER_POOL_SIZE` | `2` | Number of worker processes |
| `WORKER_MAX_RUNS_PER_WORKER` | `50` | Recycle worker after N runs |
| `WORKER_TASK_TIMEOUT_MS` | `300000` | Kill/recycle worker on hung task |
| `WORKER_MEMORY_LIMIT_MB` | `512` | Recycle worker above RSS limit |
| `WORKER_MAX_QUEUE` | `100` | Max queued (not yet dispatched) tasks, else `429` |
| `WORKER_STARTUP_TIMEOUT_MS` | `15000` | Fail boot if a worker never sends `ready` |

See `.env.example`.

## Scripts

| Script | Command |
|---|---|
| dev (hot reload, master) | `bun run start:dev` |
| start (master) | `bun run start` |
| single worker (debug) | `bun run start:worker` |
| prod (from `dist/`) | `bun run start:prod` |
| build (`tsc`) | `bun run build` |
| typecheck | `bun run typecheck` |

Note: `start:worker` runs one worker standalone (no master). Without an IPC channel `process.send` is a no-op — useful only to verify the worker boots.

## Project structure

```
src/
  main.ts                              # master bootstrap (HTTP)
  worker.ts                            # worker bootstrap (IPC + AgentExecutionModule only)
  app.module.ts                        # AppModule: AgentsModule + health
  app.controller.ts / app.service.ts   # GET / and /health
  common/
    protocol.ts                        # MasterToWorker / WorkerToMaster IPC types
  modules/
    agents/
      agents.module.ts
      agents.controller.ts             # POST/GET/DELETE /agents/runs, GET /agents/pool
      agents.service.ts                # RunRegistry (metadata only) + pool delegation
    runtime/
      runtime.module.ts
      worker-pool.service.ts           # master-side pool: spawn, dispatch, timeout, recycle
    agent-execution/
      agent-execution.module.ts
      agent-runner.service.ts          # worker-side executor (swap with real LLM here)
```

## Plugging in a real agent

Replace the simulated loop in `src/modules/agent-execution/agent-runner.service.ts:33` (`AgentRunnerService.run`) with real LLM/tool calls. Contract to keep:

- signature `run(input, { runId, signal, onProgress })`
- respect `signal.throwIfAborted()` / pass `signal` to fetch/SDK calls
- report via `onProgress(percent, message)`
- keep no module-level mutable state; allocate per run, release in `finally`

Master, protocol, pool, and HTTP API stay unchanged.

## Build binary with Bun

```bash
bun build ./src/main.ts --compile --target bun --outfile=nestjs-workers
./nestjs-workers
```

Workers are spawned via `bun src/worker.ts`, so keep `src/` alongside the binary or adjust the spawn command for your deployment layout.
