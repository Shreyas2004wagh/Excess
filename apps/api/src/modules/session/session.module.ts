import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { SessionController } from './session.controller.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [AuthModule],
  controllers: [SessionController],
  providers: [SessionService],
})
export class SessionModule {}
