import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AgentExecutionModule } from './modules/agent-execution/agent-execution.module';
import { AgentRunnerService } from './modules/agent-execution/agent-runner.service';
import type {
  AgentRunInput,
  AgentRunResult,
} from './modules/agent-execution/agent-runner.service';
import { currentMemoryMB } from './common/protocol';
import type { MasterToWorkerMessage, WorkerToMasterMessage } from './common/protocol';

const index = process.env.WORKER_INDEX ?? '0';

function send(msg: WorkerToMasterMessage): void {
  try {
    (process as NodeJS.Process).send?.(msg);
  } catch {
    // parent may have disconnected — ignore, run still completes locally
  }
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AgentExecutionModule, {
    logger: ['error', 'warn', 'log'],
  });
  const runner = app.get(AgentRunnerService);
  const controllers = new Map<string, AbortController>();

  process.on('message', (raw: unknown) => {
    const msg = raw as MasterToWorkerMessage;
    void handle(msg).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(`[worker#${index}] handle failed:`, err);
    });
  });

  async function handle(msg: MasterToWorkerMessage): Promise<void> {
    switch (msg.kind) {
      case 'run': {
        const { runId, input } = msg;
        if (controllers.has(runId)) return;
        const controller = new AbortController();
        controllers.set(runId, controller);
        send({ kind: 'started', id: msg.id, runId });
        try {
          const result: AgentRunResult = await runner.run(input as AgentRunInput, {
            runId,
            signal: controller.signal,
            onProgress: (progress, message) => {
              send({ kind: 'progress', id: msg.id, runId, progress, message });
            },
          });
          send({ kind: 'result', id: msg.id, runId, result, memoryMB: currentMemoryMB() });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          send({ kind: 'error', id: msg.id, runId, error: message, memoryMB: currentMemoryMB() });
        } finally {
          controllers.delete(runId);
        }
        break;
      }
      case 'cancel': {
        controllers.get(msg.runId)?.abort();
        break;
      }
      case 'ping': {
        send({ kind: 'pong', id: msg.id, memoryMB: currentMemoryMB() });
        break;
      }
    }
  }

  const shutdown = async (): Promise<void> => {
    for (const [, c] of controllers) c.abort();
    controllers.clear();
    await app.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  send({ kind: 'ready' });
  // eslint-disable-next-line no-console
  console.log(`[worker#${index}] ready pid=${process.pid}`);
}

void bootstrap();
