import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { QueueConfig, QueueRegistry } from '../../src/types';
import { QueueRegistryImpl } from '../../src/registry';
import { glideMQRoutes } from '../../src/routes';

export async function buildTestApp(queues: Record<string, QueueConfig> = { default: {} }): Promise<{
  app: FastifyInstance;
  registry: QueueRegistry;
}> {
  const registry = new QueueRegistryImpl({ queues, testing: true });
  const app = Fastify();
  app.decorate('glidemq', registry);
  await app.register(glideMQRoutes);
  await app.ready();
  return { app, registry };
}
