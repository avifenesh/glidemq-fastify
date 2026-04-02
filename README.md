# @glidemq/fastify

[![npm](https://img.shields.io/npm/v/@glidemq/fastify)](https://www.npmjs.com/package/@glidemq/fastify)
[![license](https://img.shields.io/npm/l/@glidemq/fastify)](https://github.com/avifenesh/glidemq-fastify/blob/main/LICENSE)

Fastify v5 plugin that turns [glide-mq](https://github.com/avifenesh/glide-mq) queues into a REST API with real-time SSE. Two registrations give you queue operations, schedulers, flow orchestration over HTTP, rolling usage summaries, and broadcast routes.

## Why

- **Zero route boilerplate** - declare queues, get job CRUD, metrics, schedulers, and SSE endpoints
- **Testable without Valkey** - `createTestApp` builds an in-memory Fastify instance for `app.inject()` assertions
- **Serverless producers** - lightweight `POST /:name/produce` endpoint for Lambda/edge functions that only enqueue jobs

## Install

```bash
npm install @glidemq/fastify glide-mq fastify
```

Optional - install `zod` for request validation (falls back to manual checks otherwise).

Requires **glide-mq >= 0.14.0** and **Fastify 5+**.

## Quick start

```ts
import Fastify from "fastify";
import { glideMQPlugin, glideMQRoutes } from "@glidemq/fastify";

const app = Fastify();

await app.register(glideMQPlugin, {
  connection: { addresses: [{ host: "localhost", port: 6379 }] },
  queues: {
    emails: {
      processor: async (job) => {
        await sendEmail(job.data.to, job.data.subject);
        return { sent: true };
      },
      concurrency: 5,
    },
  },
});

await app.register(glideMQRoutes, { prefix: "/api/queues" });
await app.listen({ port: 3000 });
```

`glideMQPlugin` creates a registry on `app.glidemq`. `glideMQRoutes` mounts the full queue-management API. The `onClose` hook handles graceful shutdown.

## AI-native endpoints

glide-mq 0.14+ provides AI orchestration primitives - token/cost tracking, real-time streaming, human-in-the-loop suspend/signal, model failover chains, budget caps, dual-axis rate limiting, and vector search. This plugin exposes dedicated AI and flow endpoints:

- **`GET /:name/flows/:id/usage`** - aggregate token counts, costs, and model usage across a flow (parent + children)
- **`GET /:name/flows/:id/budget`** - read budget state for a flow (caps, used amounts, exceeded status)
- **`POST /flows`** - create a tree flow or DAG over HTTP with `{ flow, budget? }` or `{ dag }`
- **`GET /flows/:id`** - inspect a flow snapshot with nodes, roots, counts, usage, and budget
- **`GET /flows/:id/tree`** - inspect the nested tree view for a submitted tree flow or DAG
- **`DELETE /flows/:id`** - revoke or flag remaining jobs in a flow and delete the HTTP flow record
- **`GET /:name/jobs/:id/stream`** - SSE stream of a job's streaming channel (supports `lastId` query param and `Last-Event-ID` header for resumption)
- **`GET /usage/summary`** - rolling per-queue or cross-queue usage summary from persisted minute buckets
- **`POST /broadcast/:name`** - publish a broadcast message with a `subject`, payload, and optional job options
- **`GET /broadcast/:name/events`** - SSE stream for broadcast delivery; requires `subscription` and optionally filters `subjects`

All other AI primitives (usage metadata on jobs, signals, budget keys, fallback index, TPM tokens) are included in job serialization automatically.
HTTP-submitted budgets are currently supported for tree flows only, not DAG payloads.

```ts
// Get aggregated usage for a flow
const usage = await fetch("/api/queues/ai-tasks/flows/flow-123/usage");
// { tokens: { input: 1200, output: 800 }, totalTokens: 2000, costs: { input: 0.003 }, totalCost: 0.005, jobCount: 3, models: { "gpt-5.4": 3 } }

// Check budget state
const budget = await fetch("/api/queues/ai-tasks/flows/flow-123/budget");
// { maxTotalTokens: 10000, usedTokens: 2000, exceeded: false, onExceeded: "pause" }

// Stream job output via SSE
const stream = new EventSource("/api/queues/ai-tasks/jobs/job-456/stream");
stream.onmessage = (e) => console.log(JSON.parse(e.data));
```

## Configuration

```ts
interface GlideMQPluginOptions {
  connection?: ConnectionOptions; // Required unless testing: true
  queues: Record<string, QueueConfig>;
  producers?: Record<string, ProducerConfig>;
  prefix?: string;    // Valkey key prefix (default: "glide")
  testing?: boolean;  // In-memory mode, no Valkey needed
}
```

Route access control via `GlideMQRoutesOptions`:

```ts
await app.register(glideMQRoutes, {
  prefix: "/api/queues",
  queues: ["emails"],    // restrict queue and broadcast names
  producers: ["emails"], // restrict to specific producers
});
```

## Testing

```ts
import { createTestApp } from "@glidemq/fastify/testing";

const { app } = await createTestApp({
  emails: { processor: async (job) => ({ sent: true }) },
});

const res = await app.inject({
  method: "POST",
  url: "/emails/jobs",
  payload: { name: "welcome", data: { to: "user@test.com" } },
});
// res.statusCode === 201

await app.close();
```

## Limitations

- SSE uses `reply.hijack()`, so Fastify `onSend` hooks do not run for SSE connections.
- No built-in auth or rate limiting. Use `@fastify/auth` or `@fastify/rate-limit` in front of `glideMQRoutes`.
- `/flows*`, `GET /usage/summary`, and broadcast routes require a live `connection`; they are unavailable in testing mode.
- Queue names must match `/^[a-zA-Z0-9_-]{1,128}$/`.

## Links

- [glide-mq](https://github.com/avifenesh/glide-mq) - core library
- [Full documentation](https://glidemq.dev/integrations/fastify)
- [Issues](https://github.com/avifenesh/glidemq-fastify/issues)
- [@glidemq/hono](https://github.com/avifenesh/glidemq-hono) | [@glidemq/hapi](https://github.com/avifenesh/glidemq-hapi) | [@glidemq/nestjs](https://github.com/avifenesh/glidemq-nestjs) | [@glidemq/dashboard](https://github.com/avifenesh/glidemq-dashboard)

## License

[Apache-2.0](./LICENSE)
