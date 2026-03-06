import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { glideMQPlugin } from '../src/plugin';
import { QueueRegistryImpl } from '../src/registry';

describe('glideMQPlugin', () => {
  it('decorates fastify.glidemq with registry', async () => {
    const app = Fastify();
    await app.register(glideMQPlugin, { queues: { test: {} }, testing: true });
    await app.ready();

    expect(app.glidemq).toBeDefined();
    expect(app.glidemq.testing).toBe(true);
    expect(app.glidemq.names()).toEqual(['test']);

    await app.close();
  });

  it('shares same registry across requests', async () => {
    const app = Fastify();
    await app.register(glideMQPlugin, { queues: { test: {} }, testing: true });

    let firstRef: any;
    let secondRef: any;

    app.get('/first', async (request) => {
      firstRef = request.server.glidemq;
      return { ok: true };
    });
    app.get('/second', async (request) => {
      secondRef = request.server.glidemq;
      return { ok: true };
    });

    await app.ready();
    await app.inject({ method: 'GET', url: '/first' });
    await app.inject({ method: 'GET', url: '/second' });

    expect(firstRef).toBe(secondRef);

    await app.close();
  });

  it('exposes getConnection and getPrefix', async () => {
    const app = Fastify();
    await app.register(glideMQPlugin, { queues: { test: {} }, testing: true, prefix: 'myprefix' });
    await app.ready();

    expect(app.glidemq.getConnection()).toBeUndefined();
    expect(app.glidemq.getPrefix()).toBe('myprefix');

    await app.close();
  });

  it('throws if no connection and not testing', async () => {
    const app = Fastify();
    await expect(app.register(glideMQPlugin, { queues: { test: {} } })).rejects.toThrow('connection is required');
  });

  it('accepts a pre-constructed QueueRegistry', async () => {
    const registry = new QueueRegistryImpl({ queues: { emails: {} }, testing: true });
    const app = Fastify();
    await app.register(glideMQPlugin, registry as any);
    await app.ready();

    expect(app.glidemq.testing).toBe(true);
    expect(app.glidemq.names()).toEqual(['emails']);

    await app.close();
  });

  it('closes registry on server close', async () => {
    const app = Fastify();
    await app.register(glideMQPlugin, { queues: { test: {} }, testing: true });
    await app.ready();

    const registry = app.glidemq;
    registry.get('test'); // Initialize a queue

    await app.close();

    expect(() => registry.get('test')).toThrow('closed');
  });
});
