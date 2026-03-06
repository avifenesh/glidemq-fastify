import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { QueueConfig, QueueRegistry } from './types';
import { QueueRegistryImpl } from './registry';
import { glideMQRoutes } from './routes';

export async function createTestApp(
  queues: Record<string, QueueConfig>,
  opts?: { prefix?: string },
): Promise<{ app: FastifyInstance; registry: QueueRegistry }> {
  const registry = new QueueRegistryImpl({ queues, testing: true });

  const app = Fastify();
  app.decorate('glidemq', registry);
  app.addHook('onClose', async () => {
    await registry.closeAll();
  });
  await app.register(glideMQRoutes, { prefix: opts?.prefix });
  await app.ready();

  return { app, registry };
}
