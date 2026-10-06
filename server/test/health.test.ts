import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

describe('HTTP API Endpoints', () => {
  const app = createApp();

  it('GET /api/v1/health should return 200 with status ok', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ok');
    expect(res.body).toHaveProperty('service', 'SyncCode Server');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('GET /api/v1/nonexistent should return 404', async () => {
    const res = await request(app).get('/api/v1/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('status', 'error');
  });
});
