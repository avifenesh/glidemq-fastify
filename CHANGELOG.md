# Changelog

## 0.3.3

- Validate against glide-mq 0.20.0 and cover bounded scheduler inventory through the real SDK, including limit rejection and existing inventory behavior.
- Keep the supported glide-mq peer range and existing HTTP behavior unchanged.
- Fix record-schema construction for Zod 4 while retaining Zod 3 compatibility. Test with patched Zod 4 by default.
- Refresh development Fastify, fast-uri and Vitest entries for current advisories.

## 0.3.2

- Validate against glide-mq 0.17.0 and replace the floating development dependency with an explicit compatible range.
- Include the merged dependency security updates.

## 0.3.0

- Add `GET /usage/summary` and broadcast routes: `POST /broadcast/:name` and `GET /broadcast/:name/events` (SSE).
- Add flow HTTP routes for `POST /flows`, `GET /flows/:id`, `GET /flows/:id/tree`, and `DELETE /flows/:id`. `DELETE` revokes the flow's jobs.
- Require glide-mq >=0.15.0 for the new flow and broadcast endpoints.
- Correction: this entry first listed DLQ, suspended-job, revoke, global rate-limit and per-job lifecycle SSE routes. They never shipped.

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
