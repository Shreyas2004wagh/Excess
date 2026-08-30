import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@excess/shared-types';

@Injectable()
export class HealthService {
  getHealth(): HealthResponse {
    return {
      service: 'excess-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
