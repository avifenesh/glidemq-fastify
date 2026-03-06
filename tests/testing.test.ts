import { describe, it, expect, afterEach } from 'vitest';
import { createTestApp } from '../src/testing';

describe('createTestApp', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('returns a working app and registry', async () => {
    const { app, registry } = await createTestApp({
      emails: { processor: async (job: any) => ({ sent: true, to: job.data.to }) },
      reports: {},
    });
    cleanup = () => app.close();

    expect(registry.testing).toBe(true);
    expect(registry.names()).toEqual(['emails', 'reports']);

    const res = await app.inject({
      method: 'POST',
      url: '/emails/jobs',
      payload: { name: 'welcome', data: { to: 'user@test.com' } },
    });

    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job.name).toBe('welcome');
    expect(job.data).toEqual({ to: 'user@test.com' });
  });

  it('supports all API routes', async () => {
    const { app } = await createTestApp({ tasks: {} });
    cleanup = () => app.close();

    const addRes = await app.inject({
      method: 'POST',
      url: '/tasks/jobs',
      payload: { name: 'do-thing', data: { x: 1 } },
    });
    expect(addRes.statusCode).toBe(201);

    const countsRes = await app.inject({ method: 'GET', url: '/tasks/counts' });
    expect(countsRes.statusCode).toBe(200);
    const counts = countsRes.json();
    expect(counts).toHaveProperty('waiting');

    const listRes = await app.inject({ method: 'GET', url: '/tasks/jobs?type=waiting' });
    expect(listRes.statusCode).toBe(200);
    const jobs = listRes.json();
    expect(Array.isArray(jobs)).toBe(true);
  });

  it('returns 404 for unconfigured queues', async () => {
    const { app } = await createTestApp({ emails: {} });
    cleanup = () => app.close();

    const res = await app.inject({ method: 'GET', url: '/unknown/counts' });
    expect(res.statusCode).toBe(404);
  });

  it('app.close() also closes the registry', async () => {
    const { app, registry } = await createTestApp({ emails: {} });

    // Access a queue so it gets lazily initialized
    registry.get('emails');

    await app.close();

    // Registry should be closed — further get() calls should throw
    expect(() => registry.get('emails')).toThrow('closed');
  });
});
