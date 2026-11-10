import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AgentsModule } from './modules/agents/agents.module';

@Module({
  imports: [AgentsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
