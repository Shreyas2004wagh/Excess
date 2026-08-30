import { HealthService } from './health.service.js';

describe('HealthService', () => {
  it('reports that the API is healthy', () => {
    const health = new HealthService().getHealth();

    expect(health.service).toBe('excess-api');
    expect(health.status).toBe('ok');
    expect(health.timestamp).toBeDefined();
  });
});
