import { Controller, Get } from '@nestjs/common';

import { Public } from '../auth/public.decorator.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @Public()
  getHealth() {
    return this.healthService.getHealth();
  }
}
