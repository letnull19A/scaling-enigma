import { Module } from '@nestjs/common';
import { AgentRunnerService } from './agent-runner.service';

@Module({
  providers: [AgentRunnerService],
  exports: [AgentRunnerService],
})
export class AgentExecutionModule {}
