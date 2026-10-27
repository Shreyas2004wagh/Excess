import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import type { Response } from 'express';

import type { ObservableRequest } from './request-observability.middleware.js';

@Catch()
export class SafeHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const request = http.getRequest<ObservableRequest>();
    const response = http.getResponse<Response>();
    const expected = exception instanceof HttpException;
    const status = expected ? exception.getStatus() : 500;
    if (!expected) request.internalHttpError = true;
    // The completion middleware emits a sanitized error event. Do not pass
    // unknown errors to Nest's default logger: SDK/SQL errors can embed PII,
    // connection strings, request bodies or credentials in message/stack.
    if (response.headersSent) {
      response.end();
      return;
    }
    if (expected) {
      const body = exception.getResponse();
      response
        .status(status)
        .json(
          typeof body === 'string'
            ? { statusCode: status, message: body }
            : body,
        );
    } else {
      response.status(500).json({
        statusCode: 500,
        message: 'Internal server error',
        requestId: request.requestId,
      });
    }
  }
}
