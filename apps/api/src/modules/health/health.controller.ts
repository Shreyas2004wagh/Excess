import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Public } from '../auth/public.decorator.js';
import { SkipRateLimit } from '../operational/skip-rate-limit.decorator.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  @SkipRateLimit()
  getHealth() {
    return this.healthService.getHealth();
  }

  @Get('ready')
  @Public()
  @SkipRateLimit()
  async getReadiness(@Res({ passthrough: true }) response: Response) {
    const readiness = await this.healthService.getReadiness();
    if (readiness.status === 'not_ready') {
      response.status(503);
    }
    return readiness;
  }
}
