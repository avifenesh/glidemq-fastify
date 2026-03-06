import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { QueueRegistry } from './types';

interface EventSubscription {
  queueEvents: any;
  refCount: number;
}

const QueueEventsClass: { new (name: string, opts: any): any } | null = (() => {
  try {
    return (require('glide-mq') as any).QueueEvents;
  } catch {
    return null;
  }
})();

function writeSSE(reply: FastifyReply, event: string, data: string, id: string): boolean {
  try {
    reply.raw.write(`event: ${event}\ndata: ${data}\nid: ${id}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function cancellableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function getSubscriptions(fastify: FastifyInstance): Map<string, EventSubscription> {
  if (!(fastify as any).__glidemq_subscriptions) {
    const subs = new Map<string, EventSubscription>();
    (fastify as any).__glidemq_subscriptions = subs;
    fastify.addHook('onClose', async () => {
      for (const sub of subs.values()) {
        try { await sub.queueEvents.close(); } catch {}
      }
      subs.clear();
    });
  }
  return (fastify as any).__glidemq_subscriptions;
}

function acquireQueueEvents(
  subscriptions: Map<string, EventSubscription>,
  name: string,
  connectionOpts: any,
  prefix?: string,
): any {
  const existing = subscriptions.get(name);
  if (existing) {
    existing.refCount++;
    return existing.queueEvents;
  }

  if (!QueueEventsClass) {
    throw new Error('glide-mq is required for live SSE events');
  }

  const queueEvents = new QueueEventsClass(name, {
    connection: connectionOpts,
    prefix,
  });

  subscriptions.set(name, { queueEvents, refCount: 1 });
  return queueEvents;
}

function releaseQueueEvents(subscriptions: Map<string, EventSubscription>, name: string): void {
  const sub = subscriptions.get(name);
  if (!sub) return;
  sub.refCount--;
  if (sub.refCount <= 0) {
    sub.queueEvents.close().catch(() => {});
    subscriptions.delete(name);
  }
}

export function createEventsRoute(fastify: FastifyInstance): void {
  fastify.get<{ Params: { name: string } }>('/:name/events', async (request, reply) => {
    const { name } = request.params;
    const registry = fastify.glidemq;

    reply.hijack();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
    });
    reply.raw.write(':ok\n\n');

    const handler = registry.testing
      ? handleTestingSSE(request, reply, registry, name)
      : handleLiveSSE(request, reply, fastify, registry, name);

    handler.catch(() => {
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    });
  });
}

async function handleLiveSSE(
  request: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  registry: QueueRegistry,
  name: string,
): Promise<void> {
  const connection = registry.getConnection();
  const prefix = registry.getPrefix();

  if (!connection) {
    writeSSE(reply, 'error', JSON.stringify({ message: 'No connection configured' }), '0');
    reply.raw.end();
    return;
  }

  const subscriptions = getSubscriptions(fastify);
  const queueEvents = acquireQueueEvents(subscriptions, name, connection, prefix);
  let eventId = 0;
  let running = true;
  const ac = new AbortController();

  const eventTypes = ['completed', 'failed', 'progress', 'stalled', 'active', 'waiting'];
  const listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

  for (const eventType of eventTypes) {
    const handler = (args: any) => {
      if (!running) return;
      writeSSE(reply, eventType, JSON.stringify({ ...args, queue: name }), String(eventId++));
    };
    queueEvents.on(eventType, handler);
    listeners.push({ event: eventType, handler });
  }

  request.raw.on('close', () => {
    running = false;
    ac.abort();
  });

  try {
    while (running) {
      if (!writeSSE(reply, 'heartbeat', JSON.stringify({ time: Date.now() }), String(eventId++))) {
        break;
      }
      await cancellableSleep(15_000, ac.signal);
    }
  } finally {
    for (const { event, handler } of listeners) {
      queueEvents.removeListener(event, handler);
    }
    releaseQueueEvents(subscriptions, name);
    if (!reply.raw.writableEnded) {
      reply.raw.end();
    }
  }
}

async function handleTestingSSE(
  request: FastifyRequest,
  reply: FastifyReply,
  registry: QueueRegistry,
  name: string,
): Promise<void> {
  let eventId = 0;
  const { queue } = registry.get(name);
  let lastCounts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  let running = true;
  const ac = new AbortController();

  request.raw.on('close', () => {
    running = false;
    ac.abort();
  });

  while (running) {
    try {
      const counts = await queue.getJobCounts();
      if (!running) break;

      for (const [state, count] of Object.entries(counts) as [string, number][]) {
        const prev = (lastCounts as any)[state] ?? 0;
        if (count !== prev) {
          writeSSE(reply, 'counts', JSON.stringify({ queue: name, state, count, prev }), String(eventId++));
        }
      }
      lastCounts = counts;
    } catch {
      break;
    }
    await cancellableSleep(1_000, ac.signal);
  }

  if (!reply.raw.writableEnded) {
    reply.raw.end();
  }
}
