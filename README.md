# @glidemq/fastify

[![npm](https://img.shields.io/npm/v/@glidemq/fastify)](https://www.npmjs.com/package/@glidemq/fastify)
[![license](https://img.shields.io/npm/l/@glidemq/fastify)](https://github.com/avifenesh/glidemq-fastify/blob/main/LICENSE)

REST API and real-time SSE for [glide-mq](https://github.com/avifenesh/glide-mq) job queues, as a Fastify v5 plugin. Two registrations -- declare queues, get 21 endpoints.

> If glide-mq is useful to you, consider [giving it a star](https://github.com/avifenesh/glide-mq). It helps others discover the project.

## Install

```bash
npm install @glidemq/fastify glide-mq fastify
```

Optional -- install `zod` for request validation (falls back to manual checks otherwise):

```bash
npm install zod
```

Requires **glide-mq 0.9+**.

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

What happened: `glideMQPlugin` created a `QueueRegistry`, started a worker for `emails`, and decorated the Fastify instance with `app.glidemq`. `glideMQRoutes` mounted 21 REST + SSE endpoints under `/api/queues`. The `onClose` hook will shut down all queues and workers when the process exits.

## Why @glidemq/fastify

- Use this when you need a queue management API on top of Fastify without writing route handlers yourself.
- Use this when you want real-time SSE events for job completion, failure, progress, and stalls.
- Use this when you need lightweight `Producer` endpoints for serverless or edge functions that only enqueue jobs.
- Use this when you want to test queue logic with `app.inject()` and no running Valkey instance.
- Use this when you already have a Fastify app and want to add queue operations behind a route prefix with access control.

## How It Works

The package exposes two Fastify plugins that you register separately:

**`glideMQPlugin`** -- Core plugin, wrapped with `fastify-plugin` so it shares the encapsulation context. It creates a `QueueRegistry` that lazily initializes queues and workers on first access, eagerly initializes producers so connection errors surface at startup, and decorates the Fastify instance with `app.glidemq`. An `onClose` hook calls `registry.closeAll()` for graceful shutdown.

**`glideMQRoutes`** -- REST API plugin. Not wrapped with `fastify-plugin`, so it respects Fastify's encapsulation and supports `prefix`. It reads `app.glidemq` from the parent context and mounts all 21 endpoints. You can register it multiple times with different prefixes.

## Endpoints

21 endpoints total. All queue routes use `:name` as the queue identifier.

### Jobs

| Method | Path | Description |
|--------|------|-------------|
| POST | `/:name/jobs` | Add a job |
| POST | `/:name/jobs/wait` | Add a job and wait for its result |
| GET | `/:name/jobs` | List jobs (`?type=waiting&start=0&end=-1&excludeData=false`) |
| GET | `/:name/jobs/:id` | Get a single job by ID |
| POST | `/:name/jobs/:id/priority` | Change job priority |
| POST | `/:name/jobs/:id/delay` | Change job delay |
| POST | `/:name/jobs/:id/promote` | Promote a delayed job to waiting |

### Queue Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | `/:name/counts` | Job counts by state |
| GET | `/:name/metrics` | Queue metrics (`?type=completed&start=0&end=-1`) |
| POST | `/:name/pause` | Pause the queue |
| POST | `/:name/resume` | Resume the queue |
| POST | `/:name/drain` | Drain all waiting jobs |
| POST | `/:name/retry` | Retry failed jobs (`{"count": 50}` or omit for all) |
| DELETE | `/:name/clean` | Clean old jobs (`?grace=0&limit=100&type=completed`) |
| GET | `/:name/workers` | List active workers |
| GET | `/:name/events` | SSE event stream |
| POST | `/:name/produce` | Add a job via Producer (serverless) |

### Schedulers

| Method | Path | Description |
|--------|------|-------------|
| GET | `/:name/schedulers` | List all schedulers |
| GET | `/:name/schedulers/:schedulerName` | Get one scheduler |
| PUT | `/:name/schedulers/:schedulerName` | Upsert a scheduler |
| DELETE | `/:name/schedulers/:schedulerName` | Remove a scheduler |

## Features

- **Two-step registration** -- `glideMQPlugin` for state, `glideMQRoutes` for HTTP. Register routes multiple times under different prefixes.
- **Lazy queue/worker init, eager producer init** -- queues and workers start on first request; producers connect at registration so errors fail fast.
- **Optional Zod validation** -- install `zod` and all request bodies and query strings are validated with structured error responses. Without Zod, manual validation still rejects bad input.
- **Real-time SSE** -- `/:name/events` uses `reply.hijack()` and streams `completed`, `failed`, `progress`, `active`, `waiting`, `stalled`, and `heartbeat` events directly on `reply.raw`.
- **Queue access control** -- pass `queues` and `producers` arrays to `glideMQRoutes` to restrict which names are accessible through the API.
- **Testing mode** -- `createTestApp` builds a Fastify instance with in-memory queues, no Valkey required. Test with `app.inject()`.
- **Graceful shutdown** -- `onClose` hook calls `registry.closeAll()` using `Promise.allSettled` so one failing close does not block the rest.
- **Serverless producers** -- lightweight `Producer` endpoints that return only `{ id }`, suitable for Lambda/edge functions that only enqueue work.

## Configuration

### GlideMQPluginOptions

```ts
interface GlideMQPluginOptions {
  connection?: ConnectionOptions; // Required unless testing: true
  queues: Record<string, QueueConfig>;
  producers?: Record<string, ProducerConfig>;
  prefix?: string;    // Valkey key prefix (default: 'glide')
  testing?: boolean;  // Use TestQueue/TestWorker, no Valkey needed
}

interface QueueConfig {
  processor?: (job: Job) => Promise<any>; // Omit for producer-only queues
  concurrency?: number;                   // Default: 1
  workerOpts?: Record<string, unknown>;
  serializer?: (job: Job) => Record<string, unknown>;
}

interface ProducerConfig {
  compression?: 'none' | 'gzip';
  serializer?: Serializer;
}
```

### GlideMQRoutesOptions

```ts
interface GlideMQRoutesOptions {
  queues?: string[];    // Allowlist of queue names (omit to allow all)
  producers?: string[]; // Allowlist of producer names (omit to allow all)
}
```

Route prefix is set via Fastify's standard `prefix` option in `app.register()`.

## Testing

`createTestApp` builds a ready-to-use Fastify instance with in-memory queues. No Valkey, no network.

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
  payload: { name: 'welcome', data: { to: 'user@test.com' } },
});
console.log(res.statusCode); // 201
console.log(res.json().id);  // job ID

await app.close();
```

Pass `{ prefix: '/api' }` as the second argument to `createTestApp` to test prefixed routes.

> SSE in testing mode emits `counts` events (polling-based state diffs) rather than job lifecycle events.

## Direct Registry Access

Use `app.glidemq` in your own routes to work with queues directly:

```ts
app.post('/send-email', async (request, reply) => {
  const { queue } = app.glidemq.get('emails');
  const job = await queue.add('send', {
    to: (request.body as any).to,
    subject: (request.body as any).subject,
  });
  return reply.send({ jobId: job?.id });
});
```

The registry exposes `get(name)`, `getProducer(name)`, `has(name)`, `names()`, `closeAll()`, and more. See the `QueueRegistry` interface in `src/types.ts`.

## Limitations

- SSE uses `reply.hijack()` to bypass Fastify's response pipeline. This means Fastify hooks like `onSend` do not run for SSE connections.
- No built-in authentication or rate limiting. Use Fastify hooks or plugins (`@fastify/auth`, `@fastify/rate-limit`) in front of `glideMQRoutes`.
- Queue names are validated against `/^[a-zA-Z0-9_-]{1,128}$/`. Names outside this pattern are rejected with 400.
- Scheduler names allow a wider character set (`/^[a-zA-Z0-9_:.-]{1,256}$/`) but are still length-limited.

## Ecosystem

| Package | Purpose |
|---------|---------|
| [glide-mq](https://github.com/avifenesh/glide-mq) | Core queue library -- producers, workers, schedulers, workflows |
| **@glidemq/fastify** | Fastify REST API + SSE plugin (this package) |
| [@glidemq/hono](https://github.com/avifenesh/glidemq-hono) | Hono REST API + SSE middleware |
| [@glidemq/hapi](https://github.com/avifenesh/glidemq-hapi) | Hapi REST API + SSE plugin |
| [@glidemq/nestjs](https://github.com/avifenesh/glidemq-nestjs) | NestJS module -- decorators, DI, lifecycle management |
| [@glidemq/dashboard](https://github.com/avifenesh/glidemq-dashboard) | Express web UI for monitoring and managing queues |
| [examples](https://github.com/avifenesh/glidemq-examples) | Framework integrations and use-case examples |

## Contributing

Bug reports and pull requests are welcome at [github.com/avifenesh/glidemq-fastify](https://github.com/avifenesh/glidemq-fastify). Run `npm test` before submitting. The `e2e-app/smoke.ts` file exercises the full plugin surface in testing mode -- run it with `npx tsx e2e-app/smoke.ts`.

## License

Apache-2.0
