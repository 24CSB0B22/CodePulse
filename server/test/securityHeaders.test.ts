import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { ENV } from '../src/config/env';

describe('Production Security: CSP & CORS (Item 5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves Content-Security-Policy and protective security headers', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);

    // Verify Helmet security headers
    expect(res.headers).toHaveProperty('content-security-policy');
    const csp = res.headers['content-security-policy'];

    // Verify CSP directives for Monaco and WebSockets/Workers
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("worker-src 'self' blob:");
    expect(csp).toContain('ws:');
    expect(csp).toContain('wss:');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");

    // Verify standard security headers
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('permits localhost origins in development / test mode', async () => {
    const app = createApp();

    // Development origin http://localhost:5173
    const resLocalhost = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'http://localhost:5173');

    expect(resLocalhost.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    // 127.0.0.1:5173
    const res127 = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'http://127.0.0.1:5173');

    expect(res127.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');

    // Disallowed origin should NOT have access-control-allow-origin header
    const resEvil = await request(app)
      .get('/api/v1/health')
      .set('Origin', 'http://malicious-site.example.com');

    expect(resEvil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('restricts CORS strictly to CLIENT_ORIGIN in production mode', async () => {
    const originalEnv = ENV.NODE_ENV;
    const originalClientOrigin = ENV.CLIENT_ORIGIN;
    (ENV as any).NODE_ENV = 'production';
    (ENV as any).CLIENT_ORIGIN = 'https://synccode.example.com';

    try {
      const prodApp = createApp();

      // Authorized production origin
      const resAllowed = await request(prodApp)
        .get('/api/v1/health')
        .set('Origin', 'https://synccode.example.com');

      expect(resAllowed.headers['access-control-allow-origin']).toBe('https://synccode.example.com');

      // Localhost should now be rejected in production
      const resLocal = await request(prodApp)
        .get('/api/v1/health')
        .set('Origin', 'http://localhost:5173');

      expect(resLocal.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      (ENV as any).NODE_ENV = originalEnv;
      (ENV as any).CLIENT_ORIGIN = originalClientOrigin;
    }
  });
});
