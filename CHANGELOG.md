# Changelog

## 0.1.0

Initial release.

- `glideMQPlugin` core plugin with lazy queue/worker initialization
- `glideMQRoutes` with 21 REST endpoints for queue management
- SSE events endpoint with QueueEvents fan-out and ref counting
- `createTestApp()` helper using TestQueue/TestWorker (no Valkey needed)
- Optional Zod validation (graceful no-op when not installed)
- Serverless Producer endpoints
- Scheduler CRUD endpoints
- Queue access control via `allowedQueues` / `allowedProducers`
- Automatic graceful shutdown via Fastify `onClose` hook
