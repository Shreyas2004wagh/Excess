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

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

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
        this.logger.log(
          JSON.stringify({
            event: 'http.request.completed',
            requestId: request.requestId,
            method: request.method,
            path: request.originalUrl,
            statusCode: failureStatus ?? response.statusCode,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
            clerkUserId: request.identity?.clerkUserId,
          }),
        );
      }),
    );
  }
}
