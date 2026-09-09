import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

const resendResponseSchema = z.object({ id: z.string().min(1) });

export interface AlertEmailMessage {
  to: string;
  subject: string;
  message: string;
  outboxEventId: string;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

@Injectable()
export class AlertEmailService {
  private readonly provider: 'disabled' | 'resend';
  private readonly apiUrl: string;
  private readonly apiKey?: string;
  private readonly from?: string;

  constructor(config: ConfigService) {
    this.provider = config.getOrThrow<'disabled' | 'resend'>('EMAIL_PROVIDER');
    this.apiUrl = config.getOrThrow<string>('RESEND_API_URL');
    this.apiKey = config.get<string>('RESEND_API_KEY');
    this.from = config.get<string>('ALERT_EMAIL_FROM');
  }

  get enabled() {
    return this.provider === 'resend';
  }

  async send(message: AlertEmailMessage) {
    if (!this.enabled || !this.apiKey || !this.from) {
      throw new Error('Alert email delivery is not configured');
    }

    const response = await fetch(`${this.apiUrl.replace(/\/$/, '')}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `price-alert-${message.outboxEventId}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: `${message.message}\n\nOpen Excess to review your paper-trading account.`,
        html: `<p>${escapeHtml(message.message)}</p><p>Open Excess to review your paper-trading account.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const providerMessage =
        body && typeof body === 'object' && 'message' in body
          ? String(body.message)
          : `HTTP ${response.status}`;
      throw new Error(`Resend rejected the alert email: ${providerMessage}`);
    }

    const parsed = resendResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('Resend returned an invalid email response');
    }
    return parsed.data.id;
  }
}
