import { Injectable, Logger } from '@nestjs/common';
import { currentMemoryMB } from '../../common/protocol';

export interface AgentRunInput {
  prompt: string;
  steps?: number;
  stepDelayMs?: number;
}

export interface AgentRunResult {
  runId: string;
  output: string;
  stepsCompleted: number;
}

export interface RunContext {
  runId: string;
  signal: AbortSignal;
  onProgress?: (progress: number, message?: string) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      cleanup();
      reject(new Error('aborted'));
    };
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Executes AI-agent work inside a WORKER process only.
 * Master never instantiates this service.
 * No shared mutable state between runs — everything is local,
 * so completed runs are fully GC-able (anti-leak by design).
 */
@Injectable()
export class AgentRunnerService {
  private readonly logger = new Logger(AgentRunnerService.name);

  async run(input: AgentRunInput, ctx: RunContext): Promise<AgentRunResult> {
    const totalSteps = Math.max(1, Math.min(input.steps ?? 5, 50));
    const stepDelay = Math.max(0, Math.min(input.stepDelayMs ?? 200, 5000));
    const chunks: string[] = [];

    this.logger.log(`[${ctx.runId}] start (${totalSteps} steps)`);

    try {
      for (let i = 1; i <= totalSteps; i += 1) {
        ctx.signal.throwIfAborted();
        // Simulate LLM/tool I/O. Replace with real LLM call here.
        await sleep(stepDelay, ctx.signal);
        chunks.push(`step${i}:${input.prompt.slice(0, 24)}`);
        ctx.onProgress?.(Math.round((i / totalSteps) * 100), `step ${i}/${totalSteps}`);
      }

      const output = chunks.join('|');
      // Explicitly release large intermediate state before returning.
      chunks.length = 0;

      this.logger.log(
        `[${ctx.runId}] done rss=${currentMemoryMB()}MB`,
      );
      return { runId: ctx.runId, output, stepsCompleted: totalSteps };
    } finally {
      // No listeners/timers survive: sleep() cleans up via signal listener removal.
      chunks.length = 0;
    }
  }
}
