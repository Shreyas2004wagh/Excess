import { Injectable } from '@nestjs/common';

export interface OperationalGauges {
  outbox: Record<'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED', number>;
  email: Record<'DISABLED' | 'PENDING' | 'SENT' | 'FAILED', number>;
}

function labels(values: Record<string, string>) {
  const entries = Object.entries(values).map(
    ([key, value]) =>
      `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
  );
  return `{${entries.join(',')}}`;
}

const httpMethods = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
  'TRACE',
  'CONNECT',
]);

export function normalizeHttpMethod(method: string) {
  const upper = method.toUpperCase();
  return httpMethods.has(upper) ? upper : 'OTHER';
}

@Injectable()
export class MetricsService {
  private readonly processStartedAt = Math.floor(
    performance.timeOrigin / 1_000,
  );
  private readonly httpRequests = new Map<string, number>();
  private readonly httpDurationCount = new Map<string, number>();
  private readonly httpDurationSeconds = new Map<string, number>();
  private readonly outboxDispatches = new Map<string, number>();
  private readonly emailAttempts = new Map<string, number>();

  observeHttpRequest(method: string, statusCode: number, durationMs: number) {
    const normalizedMethod = normalizeHttpMethod(method);
    const normalizedStatus =
      Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
        ? statusCode
        : 500;
    const seconds = Number.isFinite(durationMs)
      ? Math.max(0, durationMs) / 1_000
      : 0;
    this.increment(
      this.httpRequests,
      `${normalizedMethod}|${normalizedStatus}`,
    );
    this.increment(this.httpDurationCount, normalizedMethod);
    this.increment(this.httpDurationSeconds, normalizedMethod, seconds);
  }

  recordOutboxDispatch(result: 'published' | 'failed') {
    this.increment(this.outboxDispatches, result);
  }

  recordEmailAttempt(result: 'sent' | 'failed') {
    this.increment(this.emailAttempts, result);
  }

  render(gauges: OperationalGauges) {
    const lines = [
      '# HELP excess_process_uptime_seconds Process uptime in seconds.',
      '# TYPE excess_process_uptime_seconds gauge',
      `excess_process_uptime_seconds ${process.uptime()}`,
      '# HELP excess_process_start_time_seconds Process start Unix timestamp.',
      '# TYPE excess_process_start_time_seconds gauge',
      `excess_process_start_time_seconds ${this.processStartedAt}`,
      '# HELP excess_process_resident_memory_bytes Resident memory in bytes.',
      '# TYPE excess_process_resident_memory_bytes gauge',
      `excess_process_resident_memory_bytes ${process.memoryUsage().rss}`,
      '# HELP excess_http_requests_total Completed HTTP requests.',
      '# TYPE excess_http_requests_total counter',
    ];

    for (const [key, count] of [...this.httpRequests].sort()) {
      const [method, status] = key.split('|');
      lines.push(
        `excess_http_requests_total${labels({ method: method ?? 'UNKNOWN', status: status ?? '0' })} ${count}`,
      );
    }

    lines.push(
      '# HELP excess_http_request_duration_seconds HTTP request duration.',
      '# TYPE excess_http_request_duration_seconds summary',
    );
    for (const [method, count] of [...this.httpDurationCount].sort()) {
      const methodLabels = labels({ method });
      lines.push(
        `excess_http_request_duration_seconds_count${methodLabels} ${count}`,
      );
      lines.push(
        `excess_http_request_duration_seconds_sum${methodLabels} ${this.httpDurationSeconds.get(method) ?? 0}`,
      );
    }

    lines.push(
      '# HELP excess_outbox_dispatch_total Outbox delivery outcomes.',
      '# TYPE excess_outbox_dispatch_total counter',
    );
    for (const result of ['published', 'failed'] as const) {
      lines.push(
        `excess_outbox_dispatch_total${labels({ result })} ${this.outboxDispatches.get(result) ?? 0}`,
      );
    }

    lines.push(
      '# HELP excess_email_attempt_total Alert email outcomes.',
      '# TYPE excess_email_attempt_total counter',
    );
    for (const result of ['sent', 'failed'] as const) {
      lines.push(
        `excess_email_attempt_total${labels({ result })} ${this.emailAttempts.get(result) ?? 0}`,
      );
    }

    lines.push(
      '# HELP excess_outbox_events Current price-alert outbox events.',
      '# TYPE excess_outbox_events gauge',
    );
    for (const [status, count] of Object.entries(gauges.outbox)) {
      lines.push(`excess_outbox_events${labels({ status })} ${count}`);
    }

    lines.push(
      '# HELP excess_notification_email_deliveries Current alert email delivery records.',
      '# TYPE excess_notification_email_deliveries gauge',
    );
    for (const [status, count] of Object.entries(gauges.email)) {
      lines.push(
        `excess_notification_email_deliveries${labels({ status })} ${count}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }

  private increment(map: Map<string, number>, key: string, amount = 1) {
    map.set(key, (map.get(key) ?? 0) + amount);
  }
}
