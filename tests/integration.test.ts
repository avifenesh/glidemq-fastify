import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import http from 'http';
import type { FastifyInstance } from 'fastify';
import { Queue } from 'glide-mq';
import { QueueRegistryImpl } from '../src/registry';
import { glideMQRoutes } from '../src/routes';

const VALKEY_HOST = process.env.VALKEY_HOST ?? 'localhost';
const VALKEY_PORT = parseInt(process.env.VALKEY_PORT ?? '6379', 10);

const connection = {
  addresses: [{ host: VALKEY_HOST, port: VALKEY_PORT }],
};

let canConnect = false;
try {
  const testQueue = new Queue('__fastify_integration_check', { connection });
  await testQueue.close();
  canConnect = true;
} catch {
  canConnect = false;
}

describe.skipIf(!canConnect)('Integration (requires Valkey)', () => {
  let registry: QueueRegistryImpl;
  let app: FastifyInstance;
  const QUEUE_NAME = `fastify_test_${Date.now()}`;

  beforeAll(async () => {
    registry = new QueueRegistryImpl({
      connection,
      queues: {
        [QUEUE_NAME]: {
          processor: async (job) => ({ processed: true, data: job.data }),
          concurrency: 2,
        },
      },
    });

    app = Fastify();
    app.decorate('glidemq', registry);
    await app.register(glideMQRoutes);
    await app.ready();
  });

  afterAll(async () => {
    try {
      const managed = registry.get(QUEUE_NAME);
      if (managed.worker) {
        await managed.worker.close();
      }
      await managed.queue.obliterate({ force: true });
    } catch {
      // Ignore cleanup errors
    }
    await app.close();
    await new Promise((r) => setTimeout(r, 200));
  });

  it('adds a job via API and retrieves it', async () => {
    const addRes = await app.inject({
      method: 'POST',
      url: `/${QUEUE_NAME}/jobs`,
      payload: { name: 'email', data: { to: 'integration@test.com' } },
    });

    expect(addRes.statusCode).toBe(201);
    const job = addRes.json();
    expect(job.id).toBeDefined();
    expect(job.name).toBe('email');

    const getRes = await app.inject({
      method: 'GET',
      url: `/${QUEUE_NAME}/jobs/${job.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = getRes.json();
    expect(fetched.id).toBe(job.id);
  });

  it('gets job counts', async () => {
    const res = await app.inject({ method: 'GET', url: `/${QUEUE_NAME}/counts` });
    expect(res.statusCode).toBe(200);
    const counts = res.json();
    expect(typeof counts.waiting).toBe('number');
    expect(typeof counts.active).toBe('number');
  });

  it('lists workers', async () => {
    registry.get(QUEUE_NAME);

    const res = await app.inject({ method: 'GET', url: `/${QUEUE_NAME}/workers` });
    expect(res.statusCode).toBe(200);
    const workers = res.json();
    expect(Array.isArray(workers)).toBe(true);
  });

  it('pauses and resumes', async () => {
    const pauseRes = await app.inject({ method: 'POST', url: `/${QUEUE_NAME}/pause` });
    expect(pauseRes.statusCode).toBe(204);

    const resumeRes = await app.inject({ method: 'POST', url: `/${QUEUE_NAME}/resume` });
    expect(resumeRes.statusCode).toBe(204);
  });

  it('processes jobs end-to-end', async () => {
    const addRes = await app.inject({
      method: 'POST',
      url: `/${QUEUE_NAME}/jobs`,
      payload: {
        name: 'e2e',
        data: { payload: 'test' },
        opts: { removeOnComplete: false },
      },
    });
    expect(addRes.statusCode).toBe(201);
    const job = addRes.json();

    const { queue } = registry.get(QUEUE_NAME);
    const realJob = await queue.getJob(job.id);
    if (realJob) {
      try {
        await realJob.waitUntilFinished(100, 10_000);
      } catch {
        // May already be done
      }
    }

    const countsRes = await app.inject({ method: 'GET', url: `/${QUEUE_NAME}/counts` });
    const counts = countsRes.json();
    expect(counts.completed).toBeGreaterThanOrEqual(1);
  });

  it('drains the queue', async () => {
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: 'POST',
        url: `/${QUEUE_NAME}/jobs`,
        payload: { name: `drain-${i}`, data: {} },
      });
    }

    const res = await app.inject({ method: 'POST', url: `/${QUEUE_NAME}/drain` });
    expect(res.statusCode).toBe(204);
  });

  it('SSE events endpoint responds', async () => {
    const address = await app.listen({ port: 0 });

    const { statusCode, contentType } = await new Promise<{ statusCode: number; contentType: string }>(
      (resolve, reject) => {
        const req = http.get(`${address}/${QUEUE_NAME}/events`, (res) => {
          resolve({
            statusCode: res.statusCode!,
            contentType: res.headers['content-type'] ?? '',
          });
          res.destroy();
        });
        req.on('error', reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      },
    );

    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/event-stream');
  });
});
