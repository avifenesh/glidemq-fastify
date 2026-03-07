import type { FastifyPluginAsync } from 'fastify';
import type { GlideMQRoutesOptions, QueueRegistry } from './types';
import { serializeJob, serializeJobs } from './serializers';
import { buildSchemas, hasZod } from './schemas';
import { createEventsRoute } from './events';

const VALID_QUEUE_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_JOB_TYPES = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
const VALID_CLEAN_TYPES = ['completed', 'failed'] as const;

export const glideMQRoutes: FastifyPluginAsync<GlideMQRoutesOptions> = async (fastify, options) => {
  if (!fastify.hasDecorator('glidemq')) {
    throw new Error('glideMQPlugin must be registered before glideMQRoutes');
  }
  const allowedQueues = options?.queues;
  const allowedProducers = options?.producers;
  const schemas = hasZod() ? buildSchemas() : null;

  function getRegistry(): QueueRegistry {
    return fastify.glidemq;
  }

  // Queue name validation + access control
  fastify.addHook('preHandler', async (request, reply) => {
    const name = (request.params as any)?.name;
    if (!name) return;

    if (!VALID_QUEUE_NAME.test(name)) {
      return reply.code(400).send({ error: 'Invalid queue name' });
    }

    // Allow produce endpoint to pass through for producer-only names
    const url = request.url;
    if (url.endsWith('/produce')) {
      const registry = getRegistry();
      if ((allowedProducers && !allowedProducers.includes(name)) || !registry.hasProducer(name)) {
        return reply.code(404).send({ error: 'Producer not found or not accessible' });
      }
      return;
    }

    const registry = getRegistry();
    if ((allowedQueues && !allowedQueues.includes(name)) || !registry.has(name)) {
      return reply.code(404).send({ error: 'Queue not found or not accessible' });
    }
  });

  // Error handler
  fastify.setErrorHandler(async (error, _request, reply) => {
    fastify.log.error(error);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  // POST /:name/jobs - Add a job
  fastify.post<{ Params: { name: string } }>('/:name/jobs', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    if (schemas) {
      const result = schemas.addJobSchema.safeParse(request.body);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return reply.code(400).send({ error: 'Validation failed', details: issues });
      }
      const { name: jobName, data, opts } = result.data;
      const job = await queue.add(jobName, data, opts as any);
      if (!job) return reply.code(409).send({ error: 'Job deduplicated' });
      return reply.code(201).send(serializeJob(job));
    }

    const body = request.body as any;
    if (!body?.name || typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'Validation failed', details: ['name: Required'] });
    }

    const ALLOWED_OPTS = ['delay', 'priority', 'attempts', 'timeout', 'removeOnComplete', 'removeOnFail'];
    const rawOpts = body.opts ?? {};
    const safeOpts: Record<string, unknown> = {};
    for (const key of ALLOWED_OPTS) {
      if (key in rawOpts) safeOpts[key] = rawOpts[key];
    }
    const job = await queue.add(body.name, body.data ?? {}, safeOpts as any);
    if (!job) return reply.code(409).send({ error: 'Job deduplicated' });
    return reply.code(201).send(serializeJob(job));
  });

  // GET /:name/jobs - List jobs
  fastify.get<{ Params: { name: string }; Querystring: { type?: string; start?: string; end?: string } }>(
    '/:name/jobs',
    async (request, reply) => {
      const { name } = request.params;
      const registry = getRegistry();
      const { queue } = registry.get(name);

      if (schemas) {
        const result = schemas.getJobsQuerySchema.safeParse(request.query);
        if (!result.success) {
          const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
          return reply.code(400).send({ error: 'Validation failed', details: issues });
        }
        const { type, start, end } = result.data;
        const jobs = await queue.getJobs(type as any, start, end);
        return reply.send(serializeJobs(jobs));
      }

      const typeParam = (request.query.type ?? 'waiting') as string;
      if (!VALID_JOB_TYPES.includes(typeParam as any)) {
        return reply
          .code(400)
          .send({ error: 'Validation failed', details: [`type: must be one of ${VALID_JOB_TYPES.join(', ')}`] });
      }

      const start = parseInt((request.query.start as string) ?? '0', 10);
      const end = parseInt((request.query.end as string) ?? '-1', 10);

      if (isNaN(start) || isNaN(end)) {
        return reply.code(400).send({ error: 'Validation failed', details: ['start and end must be numbers'] });
      }

      const jobs = await queue.getJobs(typeParam as any, start, end);
      return reply.send(serializeJobs(jobs));
    },
  );

  // GET /:name/jobs/:id - Get a single job
  fastify.get<{ Params: { name: string; id: string } }>('/:name/jobs/:id', async (request, reply) => {
    const { name, id } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const job = await queue.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found' });
    }
    return reply.send(serializeJob(job));
  });

  // GET /:name/counts - Get job counts
  fastify.get<{ Params: { name: string } }>('/:name/counts', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const counts = await queue.getJobCounts();
    return reply.send(counts);
  });

  // POST /:name/pause - Pause queue
  fastify.post<{ Params: { name: string } }>('/:name/pause', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    await queue.pause();
    return reply.code(204).send();
  });

  // POST /:name/resume - Resume queue
  fastify.post<{ Params: { name: string } }>('/:name/resume', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    await queue.resume();
    return reply.code(204).send();
  });

  // POST /:name/drain - Drain queue
  fastify.post<{ Params: { name: string } }>('/:name/drain', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    await queue.drain();
    return reply.code(204).send();
  });

  // POST /:name/retry - Retry failed jobs
  fastify.post<{ Params: { name: string } }>('/:name/retry', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    if (schemas) {
      const result = schemas.retryBodySchema.safeParse(request.body ?? {});
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return reply.code(400).send({ error: 'Validation failed', details: issues });
      }
      const { count } = result.data;
      const retried = await queue.retryJobs(count != null ? { count } : undefined);
      return reply.send({ retried });
    }

    let count: number | undefined;
    try {
      const body = request.body as any;
      count = body?.count;
    } catch {
      // No body or invalid - retry all
    }

    if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
      return reply.code(400).send({ error: 'Validation failed', details: ['count must be a positive integer'] });
    }

    const retried = await queue.retryJobs(count != null ? { count } : undefined);
    return reply.send({ retried });
  });

  // DELETE /:name/clean - Clean old jobs
  fastify.delete<{ Params: { name: string }; Querystring: { grace?: string; limit?: string; type?: string } }>(
    '/:name/clean',
    async (request, reply) => {
      const { name } = request.params;
      const registry = getRegistry();
      const { queue } = registry.get(name);

      if (schemas) {
        const result = schemas.cleanQuerySchema.safeParse(request.query);
        if (!result.success) {
          const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
          return reply.code(400).send({ error: 'Validation failed', details: issues });
        }
        const { grace, limit, type } = result.data;
        const removed = await queue.clean(grace, limit, type as any);
        return reply.send({ removed: removed.length });
      }

      const typeParam = (request.query.type ?? 'completed') as string;
      if (!VALID_CLEAN_TYPES.includes(typeParam as any)) {
        return reply
          .code(400)
          .send({ error: 'Validation failed', details: [`type: must be one of ${VALID_CLEAN_TYPES.join(', ')}`] });
      }

      const grace = parseInt((request.query.grace as string) ?? '0', 10);
      const limit = parseInt((request.query.limit as string) ?? '100', 10);

      if (isNaN(grace) || isNaN(limit) || grace < 0 || limit < 1) {
        return reply.code(400).send({ error: 'Validation failed', details: ['grace must be >= 0 and limit must be >= 1'] });
      }

      const removed = await queue.clean(grace, limit, typeParam as any);
      return reply.send({ removed: removed.length });
    },
  );

  // GET /:name/workers - List workers
  fastify.get<{ Params: { name: string } }>('/:name/workers', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const workers = await queue.getWorkers();
    return reply.send(workers);
  });

  // POST /:name/produce - Add a job via Producer (lightweight, serverless)
  fastify.post<{ Params: { name: string } }>('/:name/produce', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const producer = registry.getProducer(name);

    if (schemas) {
      const result = schemas.addJobSchema.safeParse(request.body);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return reply.code(400).send({ error: 'Validation failed', details: issues });
      }
      const { name: jobName, data, opts } = result.data;
      const id = await producer.add(jobName, data, opts as any);
      if (!id) return reply.code(409).send({ error: 'Job deduplicated' });
      return reply.code(201).send({ id });
    }

    const body = request.body as any;
    if (!body?.name || typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'Validation failed', details: ['name: Required'] });
    }

    const ALLOWED_OPTS = ['delay', 'priority', 'attempts', 'timeout', 'removeOnComplete', 'removeOnFail'];
    const rawOpts = body.opts ?? {};
    const safeOpts: Record<string, unknown> = {};
    for (const key of ALLOWED_OPTS) {
      if (key in rawOpts) safeOpts[key] = rawOpts[key];
    }
    const id = await producer.add(body.name, body.data ?? {}, safeOpts as any);
    if (!id) return reply.code(409).send({ error: 'Job deduplicated' });
    return reply.code(201).send({ id });
  });

  // GET /:name/events - SSE stream
  createEventsRoute(fastify);
};
