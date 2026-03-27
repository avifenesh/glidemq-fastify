# @glidemq/fastify

[![npm](https://img.shields.io/npm/v/@glidemq/fastify)](https://www.npmjs.com/package/@glidemq/fastify)
[![license](https://img.shields.io/npm/l/@glidemq/fastify)](https://github.com/avifenesh/glidemq-fastify/blob/main/LICENSE)

Fastify v5 plugin that turns [glide-mq](https://github.com/avifenesh/glide-mq) queues into a REST API with real-time SSE - two registrations, 21 endpoints.

## Why

- **Zero route boilerplate** - declare queues, get job CRUD, metrics, schedulers, and SSE endpoints
- **Testable without Valkey** - `createTestApp` builds an in-memory Fastify instance for `app.inject()` assertions
- **Serverless producers** - lightweight `POST /:name/produce` endpoint for Lambda/edge functions that only enqueue jobs

## Install

```bash
npm install @glidemq/fastify glide-mq fastify
```

Optional - install `zod` for request validation (falls back to manual checks otherwise).

Requires **glide-mq >= 0.13.0** and **Fastify 5+**.

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

`glideMQPlugin` creates a registry on `app.glidemq`. `glideMQRoutes` mounts 21 endpoints. The `onClose` hook handles graceful shutdown.

## AI-native features

glide-mq 0.13+ provides AI orchestration primitives - token/cost tracking, real-time streaming, human-in-the-loop suspend/signal, model failover chains, budget caps, dual-axis rate limiting, and vector search. All are accessible through this plugin via the REST API or `app.glidemq` registry. See the [glide-mq docs](https://github.com/avifenesh/glide-mq) for details.

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
  queues: ["emails"],    // restrict to specific queues
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
- Queue names must match `/^[a-zA-Z0-9_-]{1,128}$/`.

## Links

- [glide-mq](https://github.com/avifenesh/glide-mq) - core library
- [Full documentation](https://avifenesh.github.io/glide-mq.dev/integrations/fastify)
- [Issues](https://github.com/avifenesh/glidemq-fastify/issues)
- [@glidemq/hono](https://github.com/avifenesh/glidemq-hono) | [@glidemq/hapi](https://github.com/avifenesh/glidemq-hapi) | [@glidemq/nestjs](https://github.com/avifenesh/glidemq-nestjs) | [@glidemq/dashboard](https://github.com/avifenesh/glidemq-dashboard)

## License

[Apache-2.0](./LICENSE)
