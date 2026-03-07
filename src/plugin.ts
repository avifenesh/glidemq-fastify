import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { GlideMQPluginOptions, QueueRegistry } from './types';
import { QueueRegistryImpl } from './registry';

const glideMQPluginImpl: FastifyPluginAsync<GlideMQPluginOptions> = async (fastify, options) => {
  const registry: QueueRegistry =
    'get' in options && typeof (options as any).get === 'function'
      ? (options as unknown as QueueRegistry)
      : new QueueRegistryImpl(options);

  // Eagerly initialize producers so connection errors surface early
  if (options.producers) {
    for (const name of Object.keys(options.producers)) {
      registry.getProducer(name);
    }
  }

  fastify.decorate('glidemq', registry);

  fastify.addHook('onClose', async () => {
    await registry.closeAll();
  });
};

export const glideMQPlugin = fp(glideMQPluginImpl, {
  fastify: '5.x',
  name: '@glidemq/fastify',
});
