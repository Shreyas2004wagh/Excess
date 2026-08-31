import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';

import { Public } from '../auth/public.decorator.js';
import { WebhooksService } from './webhooks.service.js';

function toWebRequest(request: RawBodyRequest<ExpressRequest>) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const host = request.get('host') ?? 'localhost';
  return new globalThis.Request(
    `${request.protocol}://${host}${request.originalUrl}`,
    {
      method: 'POST',
      headers,
      body: request.rawBody?.toString('utf8'),
    },
  );
}

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post('clerk')
  @Public()
  @HttpCode(204)
  async handleClerk(@Req() request: RawBodyRequest<ExpressRequest>) {
    await this.webhooks.handleClerkWebhook(toWebRequest(request));
  }
}
