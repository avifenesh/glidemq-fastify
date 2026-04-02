import type { FastifyPluginAsync } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { GlideMQRoutesOptions, QueueRegistry } from './types';
import { serializeJob, serializeJobs } from './serializers';
import { buildSchemas, hasZod } from './schemas';
import { createEventsRoute } from './events';

const VALID_QUEUE_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_JOB_TYPES = ['waiting', 'active', 'delayed', 'completed', 'failed'] as const;
const VALID_CLEAN_TYPES = ['completed', 'failed'] as const;
const VALID_METRICS_TYPES = ['completed', 'failed'] as const;
const VALID_SCHEDULER_NAME = /^[a-zA-Z0-9_:.-]{1,256}$/;
const SSE_BLOCK_MS = 5_000;
const SSE_HEARTBEAT_MS = 15_000;

const ALLOWED_OPTS = [
  'delay', 'priority', 'attempts', 'timeout', 'removeOnComplete', 'removeOnFail',
  'jobId', 'lifo', 'deduplication', 'ordering', 'cost', 'backoff', 'parent', 'ttl',
];

type BroadcastClient = {
  matcher: ((subject: string) => boolean) | null;
  reply: ServerResponse;
};

type SharedBroadcastStream = {
  clients: Set<BroadcastClient>;
  closing: boolean;
  ready: Promise<void>;
  worker: { close: () => Promise<void> };
  close: () => Promise<void>;
};

type FlowKind = 'tree' | 'dag';

type FlowDefinition = {
  name: string;
  queueName: string;
  data: unknown;
  opts?: Record<string, unknown>;
  children?: FlowDefinition[];
};

type DagDefinition = {
  nodes: Array<{
    name: string;
    queueName: string;
    data: unknown;
    opts?: Record<string, unknown>;
    deps?: string[];
  }>;
};

type FlowJobRef = {
  jobId: string;
  queueName: string;
};

type FlowNodeSummary = ReturnType<typeof serializeJob> & {
  flowId: string;
  queueName: string;
  state: string;
  parentIds?: string[];
  parentQueues?: string[];
};

type FlowTreeNode = FlowNodeSummary & {
  children: FlowTreeNode[];
};

function pickOpts(rawOpts: Record<string, unknown>): Record<string, unknown> {
  const safeOpts: Record<string, unknown> = {};
  for (const key of ALLOWED_OPTS) {
    if (key in rawOpts) safeOpts[key] = rawOpts[key];
  }
  return safeOpts;
}

function parseIntegerQuery(raw: string | undefined, name: string, opts?: { min?: number }): number | undefined {
  if (raw == null) return undefined;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (opts?.min != null && value < opts.min) {
    throw new Error(`${name} must be >= ${opts.min}`);
  }
  return value;
}

function parseCsvQuery(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function writeSSEChunk(reply: ServerResponse, event: string, data: string, id?: string): boolean {
  try {
    if (id != null) reply.write(`id: ${id}\n`);
    reply.write(`event: ${event}\n`);
    reply.write(`data: ${data}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function flowMetaKey(flowId: string, prefix?: string): string {
  return `${prefix ?? 'glide'}:flow:${flowId}:meta`;
}

function flowJobsKey(flowId: string, prefix?: string): string {
  return `${prefix ?? 'glide'}:flow:${flowId}:jobs`;
}

function flowRootsKey(flowId: string, prefix?: string): string {
  return `${prefix ?? 'glide'}:flow:${flowId}:roots`;
}

function encodeFlowJobRef(ref: FlowJobRef): string {
  return `${ref.queueName}:${ref.jobId}`;
}

function decodeFlowJobRef(raw: string): FlowJobRef | null {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  return { queueName: raw.slice(0, separator), jobId: raw.slice(separator + 1) };
}

function hashEntriesToRecord(hashData: any): Record<string, string> | null {
  if (!Array.isArray(hashData) || hashData.length === 0) return null;
  const record: Record<string, string> = Object.create(null);
  for (const entry of hashData) {
    const key = entry?.field ?? entry?.key;
    if (key == null) continue;
    record[String(key)] = String(entry.value);
  }
  return Object.keys(record).length > 0 ? record : null;
}

function collectFlowQueueNames(flow: FlowDefinition, acc: Set<string> = new Set()): Set<string> {
  acc.add(flow.queueName);
  for (const child of flow.children ?? []) {
    collectFlowQueueNames(child, acc);
  }
  return acc;
}

function collectDagQueueNames(dag: DagDefinition): Set<string> {
  const names = new Set<string>();
  for (const node of dag.nodes) {
    names.add(node.queueName);
  }
  return names;
}

function buildFlowTreeNodes(flowId: string, roots: FlowJobRef[], nodes: FlowNodeSummary[]): FlowTreeNode[] {
  const nodeMap = new Map<string, FlowNodeSummary>();
  const childrenByParent = new Map<string, FlowNodeSummary[]>();

  for (const node of nodes) {
    nodeMap.set(encodeFlowJobRef({ jobId: node.id, queueName: node.queueName }), node);

    const parentRefs: FlowJobRef[] = [];
    if (node.parentIds && node.parentQueues && node.parentIds.length === node.parentQueues.length) {
      for (let i = 0; i < node.parentIds.length; i++) {
        parentRefs.push({ jobId: node.parentIds[i], queueName: node.parentQueues[i] });
      }
    } else if (node.parentId) {
      parentRefs.push({ jobId: node.parentId, queueName: node.queueName });
    }

    for (const parentRef of parentRefs) {
      const key = encodeFlowJobRef(parentRef);
      const siblings = childrenByParent.get(key);
      if (siblings) siblings.push(node);
      else childrenByParent.set(key, [node]);
    }
  }

  function visit(ref: FlowJobRef, path: Set<string>): FlowTreeNode {
    const key = encodeFlowJobRef(ref);
    const node = nodeMap.get(key);
    if (!node) {
      return {
        attemptsMade: 0,
        children: [],
        data: null,
        failedReason: undefined,
        finishedOn: undefined,
        flowId,
        id: ref.jobId,
        name: '',
        opts: {},
        parentId: undefined,
        parentIds: undefined,
        parentQueue: undefined,
        parentQueues: undefined,
        processedOn: undefined,
        progress: 0,
        queueName: ref.queueName,
        returnvalue: undefined,
        state: 'missing',
        timestamp: 0,
      };
    }

    const children = (childrenByParent.get(key) ?? [])
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp || a.queueName.localeCompare(b.queueName) || a.id.localeCompare(b.id))
      .map((child) => {
        const childKey = encodeFlowJobRef({ jobId: child.id, queueName: child.queueName });
        if (path.has(childKey)) {
          return { ...child, children: [] };
        }
        const nextPath = new Set(path);
        nextPath.add(childKey);
        return visit({ jobId: child.id, queueName: child.queueName }, nextPath);
      });

    return { ...node, children };
  }

  return roots
    .slice()
    .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId))
    .map((root) => visit(root, new Set([encodeFlowJobRef(root)])));
}

export const glideMQRoutes: FastifyPluginAsync<GlideMQRoutesOptions> = async (fastify, options) => {
  if (!fastify.hasDecorator('glidemq')) {
    throw new Error('glideMQPlugin must be registered before glideMQRoutes');
  }
  const allowedQueues = options?.queues;
  const allowedProducers = options?.producers;
  const schemas = hasZod() ? buildSchemas() : null;
  const broadcastStreams = new Map<string, SharedBroadcastStream>();

  function getRegistry(): QueueRegistry {
    return fastify.glidemq;
  }

  function flowErrorStatus(message: string): number {
    return message.includes('must be') ||
      message.includes('window and windowMs') ||
      message.includes('exactly one of') ||
      message.includes('supported only for tree flows') ||
      message.includes('Invalid queue name')
      ? 400
      : 500;
  }

  function getLiveConnection(feature: string) {
    const connection = getRegistry().getConnection();
    if (!connection) {
      throw new Error(`Connection config required for ${feature}`);
    }
    return connection;
  }

  function getFlowClientQueueNames(registry: QueueRegistry): string[] {
    const names = allowedQueues ?? registry.names();
    return names.filter((name) => registry.has(name));
  }

  async function getFlowClient(registry: QueueRegistry): Promise<any> {
    const queueNames = getFlowClientQueueNames(registry);
    if (queueNames.length === 0) {
      throw new Error('Flow HTTP endpoints require at least one configured queue');
    }
    const { queue } = registry.get(queueNames[0]);
    const client = await (queue as any).getClient?.();
    if (!client) {
      throw new Error('Connection config required for flow HTTP endpoints');
    }
    return client;
  }

  function assertAllowedFlowQueues(registry: QueueRegistry, queueNames: Iterable<string>): void {
    for (const queueName of queueNames) {
      if (!VALID_QUEUE_NAME.test(queueName)) {
        throw new Error('Invalid queue name');
      }
      if ((allowedQueues && !allowedQueues.includes(queueName)) || !registry.has(queueName)) {
        throw new Error('Queue not found or not accessible');
      }
    }
  }

  async function registerFlowRecord(
    registry: QueueRegistry,
    flowId: string,
    kind: FlowKind,
    roots: FlowJobRef[],
    jobs: FlowJobRef[],
  ): Promise<void> {
    const client = await getFlowClient(registry);
    const prefix = registry.getPrefix();
    await client.hset(flowMetaKey(flowId, prefix), { createdAt: Date.now().toString(), kind });
    await client.del([flowJobsKey(flowId, prefix), flowRootsKey(flowId, prefix)]);

    if (jobs.length > 0) {
      await client.sadd(
        flowJobsKey(flowId, prefix),
        jobs
          .slice()
          .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId))
          .map(encodeFlowJobRef),
      );
      for (const ref of jobs) {
        const { queue } = registry.get(ref.queueName);
        await client.hset((queue as any).keys.job(ref.jobId), { flowId });
      }
    }

    if (roots.length > 0) {
      await client.sadd(
        flowRootsKey(flowId, prefix),
        roots
          .slice()
          .sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId))
          .map(encodeFlowJobRef),
      );
    }
  }

  async function loadFlowRecord(
    registry: QueueRegistry,
    flowId: string,
  ): Promise<{ createdAt: number; kind: FlowKind; jobs: FlowJobRef[]; roots: FlowJobRef[] } | null> {
    const client = await getFlowClient(registry);
    const prefix = registry.getPrefix();
    const meta = hashEntriesToRecord(await client.hgetall(flowMetaKey(flowId, prefix)));
    if (!meta?.kind) return null;

    const jobs = Array.from((await client.smembers(flowJobsKey(flowId, prefix))) ?? [])
      .map((entry) => decodeFlowJobRef(String(entry)))
      .filter((entry): entry is FlowJobRef => entry !== null);
    const roots = Array.from((await client.smembers(flowRootsKey(flowId, prefix))) ?? [])
      .map((entry) => decodeFlowJobRef(String(entry)))
      .filter((entry): entry is FlowJobRef => entry !== null);

    return {
      createdAt: Number(meta.createdAt || '0'),
      kind: meta.kind === 'dag' ? 'dag' : 'tree',
      jobs,
      roots,
    };
  }

  async function deleteFlowRecord(registry: QueueRegistry, flowId: string): Promise<void> {
    const client = await getFlowClient(registry);
    const prefix = registry.getPrefix();
    await client.del([flowMetaKey(flowId, prefix), flowJobsKey(flowId, prefix), flowRootsKey(flowId, prefix)]);
  }

  async function buildFlowSnapshot(registry: QueueRegistry, flowId: string) {
    const record = await loadFlowRecord(registry, flowId);
    if (!record) return null;
    assertAllowedFlowQueues(registry, record.jobs.map((job) => job.queueName));

    const nodes: FlowNodeSummary[] = [];
    const counts: Record<string, number> = Object.create(null);
    for (const ref of record.jobs) {
      const { queue } = registry.get(ref.queueName);
      const job = await queue.getJob(ref.jobId);
      if (!job) continue;
      const state = await (job as any).getState();
      counts[state] = (counts[state] || 0) + 1;
      nodes.push({
        ...serializeJob(job),
        flowId,
        parentIds: (job as any).parentIds,
        parentQueues: (job as any).parentQueues,
        queueName: ref.queueName,
        state,
      });
    }

    let usage: unknown = null;
    let budget: unknown = null;
    if (record.roots.length === 1) {
      const root = record.roots[0];
      const { queue } = registry.get(root.queueName);
      try {
        usage = await (queue as any).getFlowUsage(root.jobId);
      } catch {
        usage = null;
      }
      try {
        budget = await (queue as any).getFlowBudget(root.jobId);
      } catch {
        budget = null;
      }
    }

    return {
      budget,
      counts,
      createdAt: record.createdAt,
      flowId,
      kind: record.kind,
      nodes: nodes.sort((a, b) => a.timestamp - b.timestamp || a.queueName.localeCompare(b.queueName) || a.id.localeCompare(b.id)),
      roots: record.roots.slice().sort((a, b) => a.queueName.localeCompare(b.queueName) || a.jobId.localeCompare(b.jobId)),
      tree: buildFlowTreeNodes(flowId, record.roots, nodes),
      usage,
    };
  }

  function removeBroadcastClient(shared: SharedBroadcastStream, client: BroadcastClient): void {
    if (!shared.clients.delete(client)) return;
    if (shared.clients.size === 0) {
      void shared.close();
    }
    try {
      if (!client.reply.writableEnded) {
        client.reply.end();
      }
    } catch {
      // ignore
    }
  }

  async function getSharedBroadcastStream(name: string, subscription: string): Promise<SharedBroadcastStream> {
    const prefix = getRegistry().getPrefix();
    const cacheKey = `${prefix ?? ''}\u0000${name}\u0000${subscription}`;
    const cached = broadcastStreams.get(cacheKey);
    if (cached) {
      await cached.ready;
      return cached;
    }

    const connection = getLiveConnection('broadcast SSE');
    const { BroadcastWorker } = require('glide-mq') as typeof import('glide-mq');
    const clients = new Set<BroadcastClient>();

    const shared: SharedBroadcastStream = {
      clients,
      closing: false,
      ready: Promise.resolve(),
      worker: null as unknown as { close: () => Promise<void> },
      close: async () => {
        if (shared.closing) return;
        shared.closing = true;
        broadcastStreams.delete(cacheKey);
        for (const client of Array.from(clients)) {
          try {
            if (!client.reply.writableEnded) {
              client.reply.end();
            }
          } catch {
            // ignore
          }
        }
        clients.clear();
        await shared.worker.close();
      },
    };

    const worker = new BroadcastWorker(
      name,
      async (job: any) => {
        const payload = JSON.stringify({
          data: job.data,
          id: job.id,
          subject: job.name,
          timestamp: job.timestamp,
        });
        for (const client of Array.from(shared.clients)) {
          if (client.matcher && !client.matcher(job.name)) continue;
          if (!writeSSEChunk(client.reply, 'message', payload, job.id)) {
            removeBroadcastClient(shared, client);
          }
        }
      },
      {
        blockTimeout: SSE_BLOCK_MS,
        connection,
        prefix,
        subscription,
      },
    );

    shared.worker = worker;
    shared.ready = worker.waitUntilReady();
    broadcastStreams.set(cacheKey, shared);

    try {
      await shared.ready;
      return shared;
    } catch (error) {
      broadcastStreams.delete(cacheKey);
      await worker.close().catch(() => undefined);
      throw error;
    }
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
    if (url.includes('/broadcast/')) {
      if (allowedQueues && !allowedQueues.includes(name)) {
        return reply.code(404).send({ error: 'Queue not found or not accessible' });
      }
      return;
    }
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

  fastify.addHook('onClose', async () => {
    for (const shared of Array.from(broadcastStreams.values())) {
      await shared.close().catch(() => undefined);
    }
    broadcastStreams.clear();
  });

  fastify.get<{ Querystring: { queues?: string; start?: string; end?: string; window?: string; windowMs?: string } }>(
    '/usage/summary',
    async (request, reply) => {
      try {
        const requestedQueues = parseCsvQuery(request.query.queues);
        if (requestedQueues) {
          for (const queueName of requestedQueues) {
            if (!VALID_QUEUE_NAME.test(queueName)) {
              return reply.code(400).send({ error: 'Invalid queue name' });
            }
            if (allowedQueues && !allowedQueues.includes(queueName)) {
              return reply.code(404).send({ error: 'Queue not found or not accessible' });
            }
          }
        }

        const window = request.query.window;
        const windowMs = request.query.windowMs;
        if (window && windowMs && window !== windowMs) {
          return reply.code(400).send({ error: 'window and windowMs must match when both are provided' });
        }

        const { Queue } = require('glide-mq') as typeof import('glide-mq');
        const summary = await (Queue as any).getUsageSummary({
          connection: getLiveConnection('usage summary'),
          endTime: parseIntegerQuery(request.query.end, 'end', { min: 0 }),
          prefix: getRegistry().getPrefix(),
          queues: requestedQueues ?? allowedQueues,
          startTime: parseIntegerQuery(request.query.start, 'start', { min: 0 }),
          windowMs: parseIntegerQuery(windowMs ?? window, windowMs ? 'windowMs' : 'window', { min: 1 }),
        });

        return reply.send(summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal server error';
        const statusCode =
          message.includes('must be') || message.includes('window and windowMs')
            ? 400
            : 500;
        return reply.code(statusCode).send({ error: message });
      }
    },
  );

  fastify.post('/flows', async (request, reply) => {
    try {
      const registry = getRegistry();
      const body = (request.body ?? {}) as { budget?: Record<string, unknown>; dag?: DagDefinition; flow?: FlowDefinition };

      if ((!!body.flow && !!body.dag) || (!body.flow && !body.dag)) {
        return reply.code(400).send({ error: 'Body must include exactly one of: flow, dag' });
      }

      const connection = getLiveConnection('flow HTTP endpoints');

      const { FlowProducer } = require('glide-mq') as typeof import('glide-mq');
      const producer = new FlowProducer({ connection, prefix: registry.getPrefix() });

      try {
        if (body.flow) {
          const queueNames = collectFlowQueueNames(body.flow);
          assertAllowedFlowQueues(registry, queueNames);
          const node = await (producer as any).add(body.flow as any, body.budget ? { budget: body.budget as any } : undefined);
          const refs: FlowJobRef[] = [];

          const collectRefs = (flowDef: FlowDefinition, jobNode: any) => {
            refs.push({ jobId: jobNode.job.id, queueName: flowDef.queueName });
            if (!flowDef.children || !jobNode.children) return;
            for (let i = 0; i < flowDef.children.length && i < jobNode.children.length; i++) {
              collectRefs(flowDef.children[i], jobNode.children[i]);
            }
          };

          collectRefs(body.flow, node);
          const root = { jobId: node.job.id, queueName: body.flow.queueName };
          await registerFlowRecord(registry, node.job.id, 'tree', [root], refs);
          return reply.code(201).send({ flowId: node.job.id, kind: 'tree', nodeCount: refs.length, root, roots: [root] });
        }

        if (body.budget) {
          return reply.code(400).send({ error: 'budget is currently supported only for tree flows' });
        }

        const dag = body.dag!;
        const queueNames = collectDagQueueNames(dag);
        assertAllowedFlowQueues(registry, queueNames);
        const jobs = await producer.addDAG(dag as any);
        const flowId = `dag-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        const refs = dag.nodes.map((dagNode) => {
          const job = jobs.get(dagNode.name);
          if (!job) throw new Error(`Missing DAG job for node ${dagNode.name}`);
          return { jobId: job.id, queueName: dagNode.queueName };
        });
        const roots = dag.nodes
          .filter((dagNode) => !dagNode.deps || dagNode.deps.length === 0)
          .map((dagNode) => ({ jobId: jobs.get(dagNode.name)!.id, queueName: dagNode.queueName }));
        await registerFlowRecord(registry, flowId, 'dag', roots, refs);
        return reply.code(201).send({
          flowId,
          jobs: dag.nodes.map((dagNode) => ({
            id: jobs.get(dagNode.name)!.id,
            name: dagNode.name,
            queueName: dagNode.queueName,
          })),
          kind: 'dag',
          nodeCount: refs.length,
          roots,
        });
      } finally {
        await producer.close().catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return reply.code(flowErrorStatus(message)).send({ error: message });
    }
  });

  fastify.get<{ Params: { id: string } }>('/flows/:id', async (request, reply) => {
    try {
      const snapshot = await buildFlowSnapshot(getRegistry(), request.params.id);
      if (!snapshot) {
        return reply.code(404).send({ error: 'Flow not found' });
      }
      return reply.send(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return reply.code(message.includes('not accessible') ? 404 : flowErrorStatus(message)).send({ error: message });
    }
  });

  fastify.get<{ Params: { id: string } }>('/flows/:id/tree', async (request, reply) => {
    try {
      const snapshot = await buildFlowSnapshot(getRegistry(), request.params.id);
      if (!snapshot) {
        return reply.code(404).send({ error: 'Flow not found' });
      }
      return reply.send({
        budget: snapshot.budget,
        counts: snapshot.counts,
        createdAt: snapshot.createdAt,
        flowId: snapshot.flowId,
        kind: snapshot.kind,
        roots: snapshot.roots,
        tree: snapshot.tree,
        usage: snapshot.usage,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return reply.code(message.includes('not accessible') ? 404 : flowErrorStatus(message)).send({ error: message });
    }
  });

  fastify.delete<{ Params: { id: string } }>('/flows/:id', async (request, reply) => {
    try {
      const registry = getRegistry();
      const flowId = request.params.id;
      const record = await loadFlowRecord(registry, flowId);
      if (!record) {
        return reply.code(404).send({ error: 'Flow not found' });
      }
      assertAllowedFlowQueues(registry, record.jobs.map((job) => job.queueName));

      let revoked = 0;
      let flagged = 0;
      let skipped = 0;
      const jobs: Array<{ id: string; queueName: string; state?: string; status: string }> = [];

      for (const ref of record.jobs) {
        const { queue } = registry.get(ref.queueName);
        const job = await queue.getJob(ref.jobId);
        if (!job) {
          skipped += 1;
          jobs.push({ id: ref.jobId, queueName: ref.queueName, status: 'missing' });
          continue;
        }
        const state = await (job as any).getState();
        if (state === 'completed' || state === 'failed') {
          skipped += 1;
          jobs.push({ id: ref.jobId, queueName: ref.queueName, state, status: 'skipped' });
          continue;
        }
        const status = await (queue as any).revoke(ref.jobId);
        if (status === 'revoked') revoked += 1;
        else if (status === 'flagged') flagged += 1;
        else skipped += 1;
        jobs.push({ id: ref.jobId, queueName: ref.queueName, state, status });
      }

      await deleteFlowRecord(registry, flowId);
      return reply.send({ flagged, flowId, jobs, revoked, skipped });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return reply.code(message.includes('not accessible') ? 404 : flowErrorStatus(message)).send({ error: message });
    }
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

    const rawOpts = body.opts ?? {};
    const safeOpts = pickOpts(rawOpts);
    const job = await queue.add(body.name, body.data ?? {}, safeOpts as any);
    if (!job) return reply.code(409).send({ error: 'Job deduplicated' });
    return reply.code(201).send(serializeJob(job));
  });

  // POST /:name/jobs/wait - Add a job and wait for result
  fastify.post<{ Params: { name: string } }>('/:name/jobs/wait', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    if (schemas) {
      const result = schemas.addAndWaitBodySchema.safeParse(request.body);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return reply.code(400).send({ error: 'Validation failed', details: issues });
      }
      const { name: jobName, data, opts, waitTimeout } = result.data;
      const returnvalue = await (queue as any).addAndWait(jobName, data, opts as any, waitTimeout);
      return reply.send({ returnvalue });
    }

    const body = request.body as any;
    if (!body?.name || typeof body.name !== 'string') {
      return reply.code(400).send({ error: 'Validation failed', details: ['name: Required'] });
    }

    const rawOpts = body.opts ?? {};
    const safeOpts = pickOpts(rawOpts);
    const returnvalue = await (queue as any).addAndWait(body.name, body.data ?? {}, safeOpts as any, body.waitTimeout);
    return reply.send({ returnvalue });
  });

  // GET /:name/jobs - List jobs
  fastify.get<{ Params: { name: string }; Querystring: { type?: string; start?: string; end?: string; excludeData?: string } }>(
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
        const { type, start, end, excludeData } = result.data;
        const jobs = excludeData
          ? await (queue as any).getJobs(type, start, end, { excludeData: true })
          : await queue.getJobs(type as any, start, end);
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

      const excludeData = request.query.excludeData === 'true' || request.query.excludeData === '1';
      const jobs = excludeData
        ? await (queue as any).getJobs(typeParam, start, end, { excludeData: true })
        : await queue.getJobs(typeParam as any, start, end);
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

  // POST /:name/jobs/:id/priority - Change job priority
  fastify.post<{ Params: { name: string; id: string } }>('/:name/jobs/:id/priority', async (request, reply) => {
    const { name, id } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const job = await queue.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    if (schemas) {
      const result = schemas.changePriorityBodySchema.safeParse(request.body);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return reply.code(400).send({ error: 'Validation failed', details: issues });
      }
      await (job as any).changePriority(result.data.priority);
      return reply.send({ ok: true });
    }

    const body = request.body as any;
    const priority = body?.priority;
    if (priority === undefined || typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0) {
      return reply.code(400).send({ error: 'Validation failed', details: ['priority must be a non-negative integer'] });
    }

    await (job as any).changePriority(priority);
    return reply.send({ ok: true });
  });

  // POST /:name/jobs/:id/delay - Change job delay
  fastify.post<{ Params: { name: string; id: string } }>('/:name/jobs/:id/delay', async (request, reply) => {
    const { name, id } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const job = await queue.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    if (schemas) {
      const result = schemas.changeDelayBodySchema.safeParse(request.body);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return reply.code(400).send({ error: 'Validation failed', details: issues });
      }
      await (job as any).changeDelay(result.data.delay);
      return reply.send({ ok: true });
    }

    const body = request.body as any;
    const delay = body?.delay;
    if (delay === undefined || typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0) {
      return reply.code(400).send({ error: 'Validation failed', details: ['delay must be a non-negative integer'] });
    }

    await (job as any).changeDelay(delay);
    return reply.send({ ok: true });
  });

  // POST /:name/jobs/:id/promote - Promote a delayed job
  fastify.post<{ Params: { name: string; id: string } }>('/:name/jobs/:id/promote', async (request, reply) => {
    const { name, id } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const job = await queue.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: 'Job not found' });
    }

    await (job as any).promote();
    return reply.send({ ok: true });
  });

  // GET /:name/counts - Get job counts
  fastify.get<{ Params: { name: string } }>('/:name/counts', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const counts = await queue.getJobCounts();
    return reply.send(counts);
  });

  // GET /:name/metrics - Get queue metrics
  fastify.get<{ Params: { name: string }; Querystring: { type?: string; start?: string; end?: string } }>(
    '/:name/metrics',
    async (request, reply) => {
      const { name } = request.params;
      const registry = getRegistry();
      const { queue } = registry.get(name);

      if (schemas) {
        const result = schemas.metricsQuerySchema.safeParse(request.query);
        if (!result.success) {
          const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
          return reply.code(400).send({ error: 'Validation failed', details: issues });
        }
        const { type, start, end } = result.data;
        const metrics = await (queue as any).getMetrics(type, { start, end });
        return reply.send(metrics);
      }

      const typeParam = (request.query.type as string) ?? '';
      if (!VALID_METRICS_TYPES.includes(typeParam as any)) {
        return reply
          .code(400)
          .send({ error: 'Validation failed', details: [`type: must be one of ${VALID_METRICS_TYPES.join(', ')}`] });
      }

      const start = parseInt((request.query.start as string) ?? '0', 10);
      const end = parseInt((request.query.end as string) ?? '-1', 10);

      if (isNaN(start) || isNaN(end)) {
        return reply.code(400).send({ error: 'Validation failed', details: ['start and end must be numbers'] });
      }

      const metrics = await (queue as any).getMetrics(typeParam, { start, end });
      return reply.send(metrics);
    },
  );

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

  // --- Scheduler endpoints ---

  // GET /:name/schedulers - List all schedulers
  fastify.get<{ Params: { name: string } }>('/:name/schedulers', async (request, reply) => {
    const { name } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const schedulers = await (queue as any).getRepeatableJobs();
    return reply.send(schedulers);
  });

  // GET /:name/schedulers/:schedulerName - Get one scheduler
  fastify.get<{ Params: { name: string; schedulerName: string } }>('/:name/schedulers/:schedulerName', async (request, reply) => {
    const { name, schedulerName } = request.params;

    if (!VALID_SCHEDULER_NAME.test(schedulerName)) {
      return reply.code(400).send({ error: 'Invalid scheduler name' });
    }

    const registry = getRegistry();
    const { queue } = registry.get(name);

    const scheduler = await (queue as any).getJobScheduler(schedulerName);
    if (!scheduler) {
      return reply.code(404).send({ error: 'Scheduler not found' });
    }
    return reply.send(scheduler);
  });

  // PUT /:name/schedulers/:schedulerName - Upsert a scheduler
  fastify.put<{ Params: { name: string; schedulerName: string } }>('/:name/schedulers/:schedulerName', async (request, reply) => {
    const { name, schedulerName } = request.params;

    if (!VALID_SCHEDULER_NAME.test(schedulerName)) {
      return reply.code(400).send({ error: 'Invalid scheduler name' });
    }

    const registry = getRegistry();
    const { queue } = registry.get(name);

    if (schemas) {
      const result = schemas.upsertSchedulerBodySchema.safeParse(request.body);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return reply.code(400).send({ error: 'Validation failed', details: issues });
      }
      const { schedule, template } = result.data;
      const job = await (queue as any).upsertJobScheduler(schedulerName, schedule, template);
      return reply.send(job ? serializeJob(job) : { ok: true });
    }

    const body = request.body as any;
    if (!body?.schedule || typeof body.schedule !== 'object') {
      return reply.code(400).send({ error: 'Validation failed', details: ['schedule: Required'] });
    }

    const job = await (queue as any).upsertJobScheduler(schedulerName, body.schedule, body.template);
    return reply.send(job ? serializeJob(job) : { ok: true });
  });

  // DELETE /:name/schedulers/:schedulerName - Remove a scheduler
  fastify.delete<{ Params: { name: string; schedulerName: string } }>('/:name/schedulers/:schedulerName', async (request, reply) => {
    const { name, schedulerName } = request.params;

    if (!VALID_SCHEDULER_NAME.test(schedulerName)) {
      return reply.code(400).send({ error: 'Invalid scheduler name' });
    }

    const registry = getRegistry();
    const { queue } = registry.get(name);

    await (queue as any).removeJobScheduler(schedulerName);
    return reply.code(204).send();
  });


  // --- AI-native endpoints ---

  // GET /:name/flows/:id/usage - Aggregate AI usage for a flow
  fastify.get<{ Params: { name: string; id: string } }>('/:name/flows/:id/usage', async (request, reply) => {
    const { name, id } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const usage = await (queue as any).getFlowUsage(id);
    return reply.send(usage);
  });

  // GET /:name/flows/:id/budget - Get budget state for a flow
  fastify.get<{ Params: { name: string; id: string } }>('/:name/flows/:id/budget', async (request, reply) => {
    const { name, id } = request.params;
    const registry = getRegistry();
    const { queue } = registry.get(name);

    const budget = await (queue as any).getFlowBudget(id);
    if (!budget) {
      return reply.code(404).send({ error: 'No budget set for this flow' });
    }
    return reply.send(budget);
  });

  // GET /:name/jobs/:id/stream - SSE stream for a job's streaming channel
  fastify.get<{ Params: { name: string; id: string }; Querystring: { lastId?: string } }>(
    '/:name/jobs/:id/stream',
    async (request, reply) => {
      const { name, id: jobId } = request.params;
      const registry = getRegistry();
      const { queue } = registry.get(name);

      reply.hijack();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });

      let lastId = (request.headers['last-event-id'] as string) || (request.query.lastId as string) || undefined;
      let closed = false;

      request.raw.on('close', () => {
        closed = true;
      });

      try {
        while (!closed) {
          const entries = await (queue as any).readStream(jobId, { lastId, count: 100 });
          for (const entry of entries) {
            reply.raw.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.fields)}\n\n`);
            lastId = entry.id;
          }

          const job = await queue.getJob(jobId);
          if (!job) break;
          const state = await (job as any).getState();
          if (state === 'completed' || state === 'failed') {
            const trailing = await (queue as any).readStream(jobId, { lastId, count: 100 });
            for (const entry of trailing) {
              reply.raw.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.fields)}\n\n`);
            }
            break;
          }

          await new Promise<void>((r) => setTimeout(r, 500));
        }
      } catch {
        // Connection lost or queue error - end gracefully
      }

      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    },
  );

  // GET /:name/events - SSE stream
  createEventsRoute(fastify);

  fastify.post<{ Params: { name: string } }>('/broadcast/:name', async (request, reply) => {
    const { name } = request.params;

    try {
      const body = (request.body ?? {}) as { data?: unknown; opts?: Record<string, unknown>; subject?: unknown };
      if (typeof body.subject !== 'string' || body.subject.trim() === '') {
        return reply.code(400).send({ error: 'Validation failed', details: ['subject: Required'] });
      }

      const connection = getLiveConnection('broadcast publish');
      const { Broadcast } = require('glide-mq') as typeof import('glide-mq');
      const broadcast = new Broadcast(name, {
        connection,
        prefix: getRegistry().getPrefix(),
      });

      try {
        const id = await broadcast.publish(body.subject, body.data ?? null, pickOpts(body.opts ?? {}) as any);
        return reply.code(id ? 201 : 200).send(id ? { id, subject: body.subject } : { skipped: true });
      } finally {
        await broadcast.close().catch(() => undefined);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      return reply.code(500).send({ error: message });
    }
  });

  fastify.get<{ Params: { name: string }; Querystring: { subscription?: string; subjects?: string } }>(
    '/broadcast/:name/events',
    async (request, reply) => {
      const { name } = request.params;
      const subscription = request.query.subscription;
      if (!subscription) {
        return reply.code(400).send({ error: 'Missing required query param: subscription' });
      }

      let shared: SharedBroadcastStream | undefined;
      let client: BroadcastClient | undefined;
      const { compileSubjectMatcher } = require('glide-mq') as typeof import('glide-mq');

      try {
        getLiveConnection('broadcast SSE');
        shared = await getSharedBroadcastStream(name, subscription);

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        reply.raw.write(':ok\n\n');

        client = {
          matcher: compileSubjectMatcher(parseCsvQuery(request.query.subjects)),
          reply: reply.raw,
        };
        shared.clients.add(client);

        request.raw.on('close', () => {
          if (shared && client) {
            removeBroadcastClient(shared, client);
          }
        });

        while (!reply.raw.writableEnded) {
          if (!writeSSEChunk(reply.raw, 'heartbeat', JSON.stringify({ time: Date.now() }))) {
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, SSE_HEARTBEAT_MS));
        }
      } catch (error) {
        if (client && shared) {
          removeBroadcastClient(shared, client);
        }
        if (!reply.sent && !reply.raw.headersSent) {
          const message = error instanceof Error ? error.message : 'Internal server error';
          return reply.code(500).send({ error: message });
        }
      }

      if (client && shared) {
        removeBroadcastClient(shared, client);
      } else if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    },
  );
};
