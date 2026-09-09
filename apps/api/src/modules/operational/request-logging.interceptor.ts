import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { finalize, tap } from 'rxjs';

import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { MetricsService } from './metrics.service.js';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();
    const startedAt = performance.now();
    let failureStatus: number | undefined;

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          failureStatus =
            error instanceof HttpException ? error.getStatus() : 500;
        },
      }),
      finalize(() => {
        const statusCode = failureStatus ?? response.statusCode;
        const durationMs = performance.now() - startedAt;
        this.metrics.observeHttpRequest(request.method, statusCode, durationMs);
        this.logger.log(
          JSON.stringify({
            event: 'http.request.completed',
            requestId: request.requestId,
            method: request.method,
            path: request.originalUrl,
            statusCode,
            durationMs: Math.round(durationMs * 100) / 100,
            clerkUserId: request.identity?.clerkUserId,
          }),
        );
      }),
    );
  }
}
