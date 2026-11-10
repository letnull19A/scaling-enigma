import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';

@Module({
  imports: [RuntimeModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
