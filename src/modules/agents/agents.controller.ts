import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { AgentsService } from './agents.service';
import type { AgentRunInput } from '../agent-execution/agent-runner.service';

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Post('runs')
  @HttpCode(HttpStatus.ACCEPTED)
  async create(@Body() input: AgentRunInput): Promise<{ runId: string; status: string }> {
    const record = await this.agents.create(input ?? { prompt: '' });
    return { runId: record.runId, status: record.status };
  }

  @Get('runs')
  list(): unknown {
    return { runs: this.agents.list(), pool: this.agents.poolStats() };
  }

  @Get('runs/:id')
  getOne(@Param('id') id: string): unknown {
    const record = this.agents.get(id);
    if (!record) throw new NotFoundException(`run ${id} not found`);
    return record;
  }

  @Delete('runs/:id')
  cancel(@Param('id') id: string): { runId: string; cancelled: boolean } {
    const record = this.agents.get(id);
    if (!record) throw new NotFoundException(`run ${id} not found`);
    const cancelled = this.agents.cancel(id);
    return { runId: id, cancelled };
  }

  @Get('pool')
  pool(): unknown {
    return this.agents.poolStats();
  }
}
