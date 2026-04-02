import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { QueueRegistryImpl } from '../src/registry';
import { glideMQRoutes } from '../src/routes';
import { buildTestApp } from './helpers/test-app';

async function buildRestrictedApp(allowedQueues: string[]) {
  const registry = new QueueRegistryImpl({
    queues: { emails: {}, reports: {}, secret: {} },
    testing: true,
  });
  const app = Fastify();
  app.decorate('glidemq', registry);
  await app.register(glideMQRoutes, { queues: allowedQueues });
  await app.ready();
  return { app, registry };
}

describe('glideMQRoutes', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  async function setup(queues?: Record<string, any>) {
    const { app, registry } = await buildTestApp(
      queues ?? {
        emails: {
          processor: async (job: any) => ({ sent: true, to: job.data.to }),
        },
        reports: {},
      },
    );
    cleanup = () => app.close();
    return { app, registry };
  }

  describe('POST /:name/jobs', () => {
    it('adds a job and returns 201', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'welcome', data: { to: 'user@test.com' } },
      });

      expect(res.statusCode).toBe(201);
      const job = res.json();
      expect(job.name).toBe('welcome');
      expect(job.data).toEqual({ to: 'user@test.com' });
      expect(job.id).toBeDefined();
    });

    it('returns 400 with error details if name is missing', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { data: { to: 'user@test.com' } },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Validation failed');
      expect(body.details).toBeDefined();
      expect(Array.isArray(body.details)).toBe(true);
    });

    it('returns 404 for unconfigured queue', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/unknown/jobs',
        payload: { name: 'test', data: {} },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /:name/jobs', () => {
    it('lists jobs', async () => {
      const { app } = await setup();

      await app.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: {} },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/emails/jobs?type=waiting',
      });
      expect(res.statusCode).toBe(200);
      const jobs = res.json();
      expect(Array.isArray(jobs)).toBe(true);
    });
  });

  describe('GET /:name/jobs/:id', () => {
    it('returns a job by id', async () => {
      const { app } = await setup();

      const addRes = await app.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: { x: 1 } },
      });
      const added = addRes.json();

      const res = await app.inject({
        method: 'GET',
        url: `/emails/jobs/${added.id}`,
      });
      expect(res.statusCode).toBe(200);
      const job = res.json();
      expect(job.id).toBe(added.id);
      expect(job.data).toEqual({ x: 1 });
    });

    it('returns 404 for missing job', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'GET',
        url: '/emails/jobs/nonexistent',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /:name/counts', () => {
    it('returns job counts', async () => {
      const { app } = await setup();

      await app.inject({ method: 'POST', url: '/emails/jobs', payload: { name: 'test1', data: {} } });
      await app.inject({ method: 'POST', url: '/emails/jobs', payload: { name: 'test2', data: {} } });

      const res = await app.inject({ method: 'GET', url: '/emails/counts' });
      expect(res.statusCode).toBe(200);
      const counts = res.json();
      expect(counts).toHaveProperty('waiting');
      expect(counts).toHaveProperty('active');
      expect(counts).toHaveProperty('completed');
      expect(counts).toHaveProperty('failed');
    });
  });

  describe('POST /:name/pause', () => {
    it('pauses the queue', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'POST', url: '/emails/pause' });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /:name/resume', () => {
    it('resumes the queue', async () => {
      const { app } = await setup();
      await app.inject({ method: 'POST', url: '/emails/pause' });
      const res = await app.inject({ method: 'POST', url: '/emails/resume' });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /:name/drain', () => {
    it('drains the queue', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'POST', url: '/emails/drain' });
      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /:name/retry', () => {
    it('retries failed jobs', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/emails/retry',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('retried');
    });

    it('handles retry with no body at all', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'POST', url: '/emails/retry' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('retried');
    });
  });

  describe('DELETE /:name/clean', () => {
    it('cleans old jobs', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'DELETE',
        url: '/emails/clean?type=completed&grace=0&limit=100',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('removed');
    });

    it('cleans with type=failed', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'DELETE',
        url: '/emails/clean?type=failed',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.removed).toBe('number');
    });

    it('defaults all params when none provided', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'DELETE', url: '/emails/clean' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /:name/workers', () => {
    it('returns worker list', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'GET', url: '/emails/workers' });
      expect(res.statusCode).toBe(200);
      const workers = res.json();
      expect(Array.isArray(workers)).toBe(true);
    });
  });

  describe('GET /:name/jobs (Zod validation)', () => {
    it('returns 400 for invalid type param', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'GET', url: '/emails/jobs?type=bogus' });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Validation failed');
      expect(body.details).toBeDefined();
    });
  });

  describe('DELETE /:name/clean (Zod validation)', () => {
    it('returns 400 for invalid type param', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'DELETE', url: '/emails/clean?type=bogus' });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Validation failed');
      expect(body.details).toBeDefined();
    });
  });

  describe('GET /:name/jobs (query params)', () => {
    it('defaults to waiting when no type param', async () => {
      const { app } = await setup();
      await app.inject({ method: 'POST', url: '/emails/jobs', payload: { name: 'test', data: {} } });

      const res = await app.inject({ method: 'GET', url: '/emails/jobs' });
      expect(res.statusCode).toBe(200);
      const jobs = res.json();
      expect(Array.isArray(jobs)).toBe(true);
    });

    it('returns empty array for type with no jobs', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'GET', url: '/emails/jobs?type=failed' });
      expect(res.statusCode).toBe(200);
      const jobs = res.json();
      expect(jobs).toEqual([]);
    });
  });

  describe('POST /:name/jobs (defaults)', () => {
    it('defaults data to empty object when omitted', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'minimal' },
      });
      expect(res.statusCode).toBe(201);
      const job = res.json();
      expect(job.name).toBe('minimal');
    });
  });

  describe('POST /:name/jobs (opts allowlist)', () => {
    it('accepts allowed opts keys', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/emails/jobs',
        payload: { name: 'test', data: {}, opts: { delay: 1000, priority: 5 } },
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('Queue name validation', () => {
    it('returns 400 for invalid queue name with special chars', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'GET', url: '/queue!@%23/counts' });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Invalid queue name');
    });

    it('returns 400 for queue name with spaces', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'GET', url: '/queue%20name/counts' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /:name/retry (Zod validation)', () => {
    it('rejects count of 0', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/emails/retry',
        payload: { count: 0 },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Validation failed');
    });

    it('rejects negative count', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/emails/retry',
        payload: { count: -5 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /:name/clean (Zod bounds)', () => {
    it('rejects negative grace', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'DELETE', url: '/emails/clean?grace=-1' });
      expect(res.statusCode).toBe(400);
    });

    it('rejects zero limit', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'DELETE', url: '/emails/clean?limit=0' });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /usage/summary', () => {
    it('returns 500 in testing mode without a live connection', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'GET', url: '/usage/summary' });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toContain('Connection config required');
    });
  });

  describe('POST /broadcast/:name', () => {
    it('returns 400 when subject is missing', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/broadcast/emails',
        payload: { data: { ok: true } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Validation failed');
    });

    it('returns 500 in testing mode after validation passes', async () => {
      const { app } = await setup();
      const res = await app.inject({
        method: 'POST',
        url: '/broadcast/emails',
        payload: { subject: 'events.created', data: { ok: true } },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toContain('Connection config required');
    });
  });

  describe('GET /broadcast/:name/events', () => {
    it('returns 400 when subscription is missing', async () => {
      const { app } = await setup();
      const res = await app.inject({ method: 'GET', url: '/broadcast/emails/events' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('subscription');
    });
  });
});

describe('glideMQRoutes with restricted queues', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('allows access to whitelisted queues', async () => {
    const { app, registry } = await buildRestrictedApp(['emails']);
    cleanup = () => app.close();

    const res = await app.inject({ method: 'GET', url: '/emails/counts' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for non-whitelisted queue', async () => {
    const { app, registry } = await buildRestrictedApp(['emails']);
    cleanup = () => app.close();

    const res = await app.inject({ method: 'GET', url: '/secret/counts' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toContain('not accessible');
  });

  it('returns 404 for non-whitelisted queue job POST', async () => {
    const { app, registry } = await buildRestrictedApp(['emails']);
    cleanup = () => app.close();

    const res = await app.inject({
      method: 'POST',
      url: '/secret/jobs',
      payload: { name: 'test', data: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for non-whitelisted broadcast publish', async () => {
    const { app, registry } = await buildRestrictedApp(['emails']);
    cleanup = () => app.close();

    const res = await app.inject({
      method: 'POST',
      url: '/broadcast/secret',
      payload: { subject: 'secret.created' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('allows multiple whitelisted queues', async () => {
    const { app, registry } = await buildRestrictedApp(['emails', 'reports']);
    cleanup = () => app.close();

    const res1 = await app.inject({ method: 'GET', url: '/emails/counts' });
    expect(res1.statusCode).toBe(200);

    const res2 = await app.inject({ method: 'GET', url: '/reports/counts' });
    expect(res2.statusCode).toBe(200);

    const res3 = await app.inject({ method: 'GET', url: '/secret/counts' });
    expect(res3.statusCode).toBe(404);
  });
});
