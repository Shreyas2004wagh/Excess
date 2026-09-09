import { describe, expect, it } from '@jest/globals';

import { MetricsService } from './metrics.service.js';

describe('MetricsService', () => {
  it('renders low-cardinality Prometheus counters and gauges', () => {
    const metrics = new MetricsService();
    metrics.observeHttpRequest('get', 200, 125);
    metrics.recordOutboxDispatch('published');
    metrics.recordEmailAttempt('sent');

    const output = metrics.render({
      outbox: { PENDING: 1, PROCESSING: 0, PUBLISHED: 2, FAILED: 0 },
      email: { DISABLED: 0, PENDING: 0, SENT: 2, FAILED: 0 },
    });

    expect(output).toContain(
      'excess_http_requests_total{method="GET",status="200"} 1',
    );
    expect(output).toContain(
      'excess_outbox_dispatch_total{result="published"} 1',
    );
    expect(output).toContain(
      'excess_notification_email_deliveries{status="SENT"} 2',
    );
  });
});
