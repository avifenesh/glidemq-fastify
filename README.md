# @glidemq/fastify

[![npm](https://img.shields.io/npm/v/@glidemq/fastify)](https://www.npmjs.com/package/@glidemq/fastify)
[![CI](https://github.com/avifenesh/glidemq-fastify/actions/workflows/ci.yml/badge.svg)](https://github.com/avifenesh/glidemq-fastify/actions)
[![license](https://img.shields.io/npm/l/@glidemq/fastify)](https://github.com/avifenesh/glidemq-fastify/blob/main/LICENSE)

Fastify plugin for [glide-mq](https://github.com/avifenesh/glide-mq) — mount a full queue management REST API and real-time SSE event stream with two plugin registrations.

Declare your queues in config, register the plugins, and get a comprehensive REST API + live SSE — no boilerplate. Uses Fastify's decorator and lifecycle patterns.

Part of the **glide-mq** ecosystem:

| Package | Purpose |
|---------|---------|
| [glide-mq](https://github.com/avifenesh/glide-mq) | Core queue library — producers, workers, schedulers, workflows |
| [@glidemq/hono](https://github.com/avifenesh/glidemq-hono) | Hono REST API + SSE middleware |
| **@glidemq/fastify** | Fastify REST API + SSE plugin (you are here) |
| [@glidemq/dashboard](https://github.com/avifenesh/glidemq-dashboard) | Express web UI for monitoring and managing queues |
| [@glidemq/nestjs](https://github.com/avifenesh/glidemq-nestjs) | NestJS module — decorators, DI, lifecycle management |
| [examples](https://github.com/avifenesh/glidemq-examples) | Framework integrations and use-case examples |

## Install

```bash
npm install @glidemq/fastify glide-mq fastify
```

Optional Zod validation:

```bash
npm install zod
```

## Quick Start

```ts
import Fastify from 'fastify';
import { glideMQPlugin, glideMQRoutes } from '@glidemq/fastify';

const app = Fastify();

await app.register(glideMQPlugin, {
  connection: { addresses: [{ host: 'localhost', port: 6379 }] },
  queues: {
    emails: {
      processor: async (job) => {
        await sendEmail(job.data.to, job.data.subject);
        return { sent: true };
      },
      concurrency: 5,
    },
    reports: {},
  },
});

await app.register(glideMQRoutes, { prefix: '/api/queues' });

await app.listen({ port: 3000 });
```

## API

### `glideMQPlugin`

Core plugin. Creates a `QueueRegistry` and decorates the Fastify instance with `fastify.glidemq`. Automatically closes all queues and workers on app shutdown via the `onClose` hook.

```ts
interface GlideMQPluginOptions {
  connection?: ConnectionOptions; // Required unless testing: true
  queues: Record<string, QueueConfig>;
  producers?: Record<string, ProducerConfig>; // Lightweight producers (serverless)
  prefix?: string;                // Key prefix (default: 'glide')
  testing?: boolean;              // Use TestQueue/TestWorker (no Valkey)
}

interface QueueConfig {
  processor?: (job: Job) => Promise<any>; // Omit for producer-only
  concurrency?: number;                   // Default: 1
  workerOpts?: Record<string, unknown>;
  serializer?: (job: Job) => Record<string, unknown>; // Custom job serializer
}

interface ProducerConfig {
  compression?: 'none' | 'gzip';
  serializer?: Serializer;
}
```

You can also pass a pre-built `QueueRegistry` instance directly:

```ts
const registry = new QueueRegistryImpl({ ... });
await app.register(glideMQPlugin, registry as any);
```

### `glideMQRoutes`

Pre-built REST API routes plugin. Requires `glideMQPlugin` to be registered first.

```ts
interface GlideMQRoutesOptions {
  queues?: string[];      // Restrict to specific queues
  producers?: string[];   // Restrict to specific producers
}
```

### REST Endpoints

#### Jobs

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/:name/jobs` | Add a job |
| POST | `/:name/jobs/wait` | Add a job and wait for result |
| GET | `/:name/jobs` | List jobs (query: `type`, `start`, `end`, `excludeData`) |
| GET | `/:name/jobs/:id` | Get a single job |
| POST | `/:name/jobs/:id/priority` | Change job priority |
| POST | `/:name/jobs/:id/delay` | Change job delay |
| POST | `/:name/jobs/:id/promote` | Promote a delayed job |

#### Queue Operations

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/:name/counts` | Get job counts by state |
| GET | `/:name/metrics` | Get queue metrics (query: `type`, `start`, `end`) |
| POST | `/:name/pause` | Pause queue |
| POST | `/:name/resume` | Resume queue |
| POST | `/:name/drain` | Drain waiting jobs |
| POST | `/:name/retry` | Retry failed jobs |
| DELETE | `/:name/clean` | Clean old jobs (query: `grace`, `limit`, `type`) |
| GET | `/:name/workers` | List active workers |
| GET | `/:name/events` | SSE event stream |
| POST | `/:name/produce` | Add a job via Producer (lightweight, serverless) |

#### Schedulers

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/:name/schedulers` | List all schedulers |
| GET | `/:name/schedulers/:schedulerName` | Get a single scheduler |
| PUT | `/:name/schedulers/:schedulerName` | Upsert a scheduler |
| DELETE | `/:name/schedulers/:schedulerName` | Remove a scheduler |

### Adding Jobs

```bash
curl -X POST http://localhost:3000/api/queues/emails/jobs \
  -H 'Content-Type: application/json' \
  -d '{"name": "welcome", "data": {"to": "user@example.com"}, "opts": {"priority": 10}}'
```

#### Advanced Job Options

The `opts` object supports the full range of glide-mq job options:

```json
{
  "name": "process",
  "data": { "key": "value" },
  "opts": {
    "delay": 5000,
    "priority": 10,
    "attempts": 3,
    "timeout": 30000,
    "jobId": "custom-id-123",
    "lifo": true,
    "ttl": 60000,
    "cost": 5,
    "backoff": { "type": "exponential", "delay": 1000, "jitter": 200 },
    "deduplication": { "id": "dedup-key", "ttl": 5000, "mode": "throttle" },
    "ordering": { "key": "user-123", "concurrency": 1 },
    "parent": { "queue": "parent-queue", "id": "parent-job-id" },
    "removeOnComplete": true,
    "removeOnFail": false
  }
}
```

### Add and Wait

Submit a job and wait for its result synchronously:

```bash
curl -X POST http://localhost:3000/api/queues/emails/jobs/wait \
  -H 'Content-Type: application/json' \
  -d '{"name": "send", "data": {"to": "user@example.com"}, "waitTimeout": 30000}'
```

Returns `{ "returnvalue": ... }` with the job's return value.

### Job Mutations

```bash
# Change job priority
curl -X POST http://localhost:3000/api/queues/emails/jobs/123/priority \
  -H 'Content-Type: application/json' \
  -d '{"priority": 1}'

# Change job delay
curl -X POST http://localhost:3000/api/queues/emails/jobs/123/delay \
  -H 'Content-Type: application/json' \
  -d '{"delay": 60000}'

# Promote a delayed job to waiting
curl -X POST http://localhost:3000/api/queues/emails/jobs/123/promote
```

### Queue Metrics

```bash
# Get completed metrics
curl 'http://localhost:3000/api/queues/emails/metrics?type=completed&start=0&end=-1'

# Get failed metrics
curl 'http://localhost:3000/api/queues/emails/metrics?type=failed'
```

### Listing Jobs with excludeData

```bash
# List jobs without data field (lighter response)
curl 'http://localhost:3000/api/queues/emails/jobs?type=completed&excludeData=true'
```

### Retrying Failed Jobs

```bash
# Retry up to 50 failed jobs
curl -X POST http://localhost:3000/api/queues/emails/retry \
  -H 'Content-Type: application/json' \
  -d '{"count": 50}'

# Retry all failed jobs (omit body or send empty object)
curl -X POST http://localhost:3000/api/queues/emails/retry
```

### Cleaning Old Jobs

```bash
# Remove completed jobs older than 1 hour, up to 200
curl -X DELETE 'http://localhost:3000/api/queues/emails/clean?grace=3600000&limit=200&type=completed'

# Remove all failed jobs (defaults: grace=0, limit=100, type=completed)
curl -X DELETE 'http://localhost:3000/api/queues/emails/clean?type=failed'
```

### Serverless (Producer)

`Producer` is a lightweight alternative to `Queue` for serverless environments — it only supports `add()` and `addBulk()`, returns string IDs, and requires no workers or event listeners.

Configure producers alongside queues:

```ts
await app.register(glideMQPlugin, {
  connection: { addresses: [{ host: 'localhost', port: 6379 }] },
  queues: {
    emails: { processor: processEmail, concurrency: 5 },
  },
  producers: {
    notifications: {},
    analytics: { compression: 'gzip' },
  },
});

await app.register(glideMQRoutes, { prefix: '/api/queues' });
```

Enqueue a job via the `/produce` endpoint:

```bash
curl -X POST http://localhost:3000/api/queues/notifications/produce \
  -H 'Content-Type: application/json' \
  -d '{"name": "push", "data": {"userId": "abc123", "message": "Hello"}}'
# → {"id": "1"}
```

The response returns only the job ID (a string), matching the lightweight nature of `Producer`.

You can also access producers directly in your own routes:

```ts
app.post('/track', async (request, reply) => {
  const producer = app.glidemq.getProducer('analytics');
  const id = await producer.add('pageview', request.body);
  return reply.send({ id });
});
```

### Schedulers

```bash
# List all schedulers
curl http://localhost:3000/api/queues/emails/schedulers

# Get a specific scheduler
curl http://localhost:3000/api/queues/emails/schedulers/daily-report

# Upsert a scheduler (cron pattern)
curl -X PUT http://localhost:3000/api/queues/emails/schedulers/daily-report \
  -H 'Content-Type: application/json' \
  -d '{
    "schedule": { "pattern": "0 9 * * *", "tz": "America/New_York" },
    "template": { "name": "report", "data": {"type": "daily"} }
  }'

# Upsert a scheduler (interval)
curl -X PUT http://localhost:3000/api/queues/emails/schedulers/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{
    "schedule": { "every": 60000 },
    "template": { "name": "ping" }
  }'

# Upsert a scheduler (repeat after complete)
curl -X PUT http://localhost:3000/api/queues/emails/schedulers/sequential \
  -H 'Content-Type: application/json' \
  -d '{
    "schedule": { "every": 5000, "repeatAfterComplete": true },
    "template": { "name": "sequential-task" }
  }'

# Remove a scheduler
curl -X DELETE http://localhost:3000/api/queues/emails/schedulers/daily-report
```


### SSE Events

The events endpoint streams real-time updates. Available event types: `completed`, `failed`, `progress`, `active`, `waiting`, `stalled`, and `heartbeat`.

```ts
const eventSource = new EventSource('/api/queues/emails/events');

eventSource.addEventListener('completed', (e) => {
  console.log('Job completed:', JSON.parse(e.data));
});

eventSource.addEventListener('failed', (e) => {
  console.log('Job failed:', JSON.parse(e.data));
});

eventSource.addEventListener('progress', (e) => {
  console.log('Job progress:', JSON.parse(e.data));
});
```

### Exported Types

```ts
import type {
  GlideMQPluginOptions,  // Core plugin options
  GlideMQRoutesOptions,  // Routes plugin options
  GlideMQConfig,         // Full configuration
  QueueConfig,           // Per-queue config (processor, concurrency, serializer)
  ProducerConfig,        // Per-producer config (compression, serializer)
  QueueRegistry,         // Registry interface (for custom implementations)
  ManagedQueue,          // { queue, worker } pair returned by registry.get()
  JobResponse,           // Serialized job shape returned by API
  JobCountsResponse,     // { waiting, active, delayed, completed, failed }
  WorkerInfoResponse,    // Worker metadata
} from '@glidemq/fastify';
```

### Utilities

For advanced use cases (custom routes, custom API sub-routers):

```ts
import { serializeJob, serializeJobs, createEventsRoute } from '@glidemq/fastify';

// serializeJob(job) - Convert a glide-mq Job to a plain JSON-safe object
// serializeJobs(jobs) - Serialize an array of jobs
// createEventsRoute() - SSE event handler factory for custom routes
```

## Testing

No Valkey needed for unit tests:

```ts
import { createTestApp } from '@glidemq/fastify/testing';

const { app, registry } = await createTestApp({
  emails: {
    processor: async (job) => ({ sent: true }),
  },
});

const res = await app.inject({
  method: 'POST',
  url: '/emails/jobs',
  payload: { name: 'test', data: {} },
});

expect(res.statusCode).toBe(201);

// Cleanup
await app.close();
```

> **Note:** SSE in testing mode emits `counts` events (polling-based state diffs) rather than job lifecycle events (`completed`, `failed`, etc.).

## Direct Registry Access

Access the registry in your own routes:

```ts
app.post('/send-email', async (request, reply) => {
  const registry = app.glidemq;
  const { queue } = registry.get('emails');

  const job = await queue.add('send', {
    to: 'user@example.com',
    subject: 'Hello',
  });

  return reply.send({ jobId: job?.id });
});
```

## Shutdown

Graceful shutdown is automatic — the `onClose` hook calls `registry.closeAll()`. For manual control:

```ts
import { glideMQPlugin, glideMQRoutes, QueueRegistryImpl } from '@glidemq/fastify';

const registry = new QueueRegistryImpl({
  connection: { addresses: [{ host: 'localhost', port: 6379 }] },
  queues: { emails: { processor: processEmail } },
});

await app.register(glideMQPlugin, registry as any);
await app.register(glideMQRoutes, { prefix: '/api/queues' });

// Or handle shutdown yourself:
process.on('SIGTERM', async () => {
  await app.close(); // triggers onClose hook → registry.closeAll()
  process.exit(0);
});
```

## License

Apache-2.0
