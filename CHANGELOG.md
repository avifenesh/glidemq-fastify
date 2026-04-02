# Changelog

## 0.3.0

- Expand the Fastify proxy surface to track glide-mq 0.15.0: queue-wide events SSE, per-job lifecycle SSE, `jobs/wait`, workers, metrics, scheduler CRUD, usage summary, broadcast publish/SSE, DLQ inspection/replay, suspended-job inspection, revoke, and queue global rate-limit management.
- Add flow HTTP routes for `POST /flows`, `GET /flows/:id`, `GET /flows/:id/tree`, and `DELETE /flows/:id`.
- Require glide-mq >=0.15.0 for the new flow and proxy-parity endpoints.

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
