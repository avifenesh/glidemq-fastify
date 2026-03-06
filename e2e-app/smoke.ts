/**
 * Smoke test: exercises @glidemq/fastify in a real Fastify app.
 * Uses testing mode (no Valkey needed).
 *
 * Run: npx tsx e2e-app/smoke.ts
 */
import Fastify from 'fastify';
import http from 'http';
import {
  glideMQPlugin,
  glideMQRoutes,
  QueueRegistryImpl,
  serializeJob,
  serializeJobs,
  createEventsRoute,
} from '../src/index';
import { createTestApp } from '../src/testing';

const passed: string[] = [];
const failed: string[] = [];

function assert(condition: boolean, msg: string) {
  if (!condition) {
    failed.push(msg);
    console.error(`  FAIL: ${msg}`);
  } else {
    passed.push(msg);
    console.log(`  PASS: ${msg}`);
  }
}

async function testPluginRegistration() {
  console.log('\n--- Plugin Registration ---');

  // 1. Register via config object
  const app1 = Fastify();
  await app1.register(glideMQPlugin, {
    queues: { emails: { processor: async (job: any) => ({ sent: true }) }, reports: {} },
    testing: true,
  });
  await app1.ready();
  assert(app1.glidemq !== undefined, 'glidemq decorator exists');
  assert(app1.glidemq.testing === true, 'testing mode enabled');
  assert(app1.glidemq.has('emails'), 'has emails queue');
  assert(app1.glidemq.has('reports'), 'has reports queue');
  assert(!app1.glidemq.has('unknown'), 'does not have unknown queue');

  // 2. Register via pre-built registry
  const registry = new QueueRegistryImpl({
    queues: { tasks: {} },
    testing: true,
  });
  const app2 = Fastify();
  await app2.register(glideMQPlugin, registry as any);
  await app2.ready();
  assert(app2.glidemq.has('tasks'), 'pre-built registry: has tasks');

  // 3. onClose cleans up
  const { queue } = app1.glidemq.get('emails');
  await app1.close();
  try {
    app1.glidemq.get('emails');
    assert(false, 'should throw after close');
  } catch {
    assert(true, 'registry closed after app.close()');
  }

  await app2.close();
}

async function testRoutesBasic() {
  console.log('\n--- Routes: Basic CRUD ---');

  const { app } = await createTestApp({
    emails: { processor: async (job: any) => ({ sent: true, to: job.data.to }) },
    reports: {},
  });

  // Add a job
  const addRes = await app.inject({
    method: 'POST',
    url: '/emails/jobs',
    payload: { name: 'welcome', data: { to: 'user@example.com' } },
  });
  assert(addRes.statusCode === 201, `POST /emails/jobs → 201 (got ${addRes.statusCode})`);
  const job = addRes.json();
  assert(typeof job.id === 'string', 'job has id');
  assert(job.name === 'welcome', 'job name matches');
  assert(job.data.to === 'user@example.com', 'job data matches');

  // Get by ID
  const getRes = await app.inject({ method: 'GET', url: `/emails/jobs/${job.id}` });
  assert(getRes.statusCode === 200, `GET /emails/jobs/${job.id} → 200`);
  const fetched = getRes.json();
  assert(fetched.id === job.id, 'fetched job id matches');

  // List jobs
  const listRes = await app.inject({ method: 'GET', url: '/emails/jobs?type=waiting' });
  assert(listRes.statusCode === 200, 'GET /emails/jobs?type=waiting → 200');
  const jobs = listRes.json();
  assert(Array.isArray(jobs), 'jobs is array');

  // Get counts
  const countsRes = await app.inject({ method: 'GET', url: '/emails/counts' });
  assert(countsRes.statusCode === 200, 'GET /emails/counts → 200');
  const counts = countsRes.json();
  assert(typeof counts.waiting === 'number', 'counts has waiting');

  // Get workers
  const workersRes = await app.inject({ method: 'GET', url: '/emails/workers' });
  assert(workersRes.statusCode === 200, 'GET /emails/workers → 200');

  // 404 for missing job
  const missing = await app.inject({ method: 'GET', url: '/emails/jobs/nonexistent' });
  assert(missing.statusCode === 404, 'missing job → 404');

  // 404 for unconfigured queue
  const unknown = await app.inject({ method: 'GET', url: '/unknown/counts' });
  assert(unknown.statusCode === 404, 'unknown queue → 404');

  await app.close();
}

async function testRoutesOperations() {
  console.log('\n--- Routes: Queue Operations ---');

  const { app } = await createTestApp({ tasks: {} });

  // Pause
  const pauseRes = await app.inject({ method: 'POST', url: '/tasks/pause' });
  assert(pauseRes.statusCode === 204, 'pause → 204');

  // Resume
  const resumeRes = await app.inject({ method: 'POST', url: '/tasks/resume' });
  assert(resumeRes.statusCode === 204, 'resume → 204');

  // Add some jobs then drain
  await app.inject({ method: 'POST', url: '/tasks/jobs', payload: { name: 'a', data: {} } });
  await app.inject({ method: 'POST', url: '/tasks/jobs', payload: { name: 'b', data: {} } });
  const drainRes = await app.inject({ method: 'POST', url: '/tasks/drain' });
  assert(drainRes.statusCode === 204, 'drain → 204');

  // Retry
  const retryRes = await app.inject({ method: 'POST', url: '/tasks/retry', payload: {} });
  assert(retryRes.statusCode === 200, 'retry → 200');
  assert(retryRes.json().hasOwnProperty('retried'), 'retry response has retried field');

  // Clean
  const cleanRes = await app.inject({ method: 'DELETE', url: '/tasks/clean?type=completed&grace=0&limit=100' });
  assert(cleanRes.statusCode === 200, 'clean → 200');
  assert(typeof cleanRes.json().removed === 'number', 'clean response has removed count');

  await app.close();
}

async function testValidation() {
  console.log('\n--- Routes: Validation ---');

  const { app } = await createTestApp({ emails: {} });

  // Missing name
  const noName = await app.inject({
    method: 'POST', url: '/emails/jobs',
    payload: { data: {} },
  });
  assert(noName.statusCode === 400, 'missing name → 400');
  assert(noName.json().error === 'Validation failed', 'error message is "Validation failed"');
  assert(Array.isArray(noName.json().details), 'has details array');

  // Invalid type
  const badType = await app.inject({ method: 'GET', url: '/emails/jobs?type=bogus' });
  assert(badType.statusCode === 400, 'invalid type → 400');

  // Invalid clean type
  const badClean = await app.inject({ method: 'DELETE', url: '/emails/clean?type=bogus' });
  assert(badClean.statusCode === 400, 'invalid clean type → 400');

  // Invalid queue name
  const badName = await app.inject({ method: 'GET', url: '/queue!@%23/counts' });
  assert(badName.statusCode === 400, 'invalid queue name → 400');

  // Retry with count=0
  const badRetry = await app.inject({
    method: 'POST', url: '/emails/retry',
    payload: { count: 0 },
  });
  assert(badRetry.statusCode === 400, 'retry count=0 → 400');

  // Clean with limit=0
  const badLimit = await app.inject({ method: 'DELETE', url: '/emails/clean?limit=0' });
  assert(badLimit.statusCode === 400, 'clean limit=0 → 400');

  // Clean with negative grace
  const badGrace = await app.inject({ method: 'DELETE', url: '/emails/clean?grace=-1' });
  assert(badGrace.statusCode === 400, 'clean grace=-1 → 400');

  await app.close();
}

async function testRestrictedQueues() {
  console.log('\n--- Routes: Restricted Queues ---');

  const registry = new QueueRegistryImpl({
    queues: { emails: {}, reports: {}, secret: {} },
    testing: true,
  });
  const app = Fastify();
  app.decorate('glidemq', registry);
  await app.register(glideMQRoutes, { queues: ['emails', 'reports'] });
  await app.ready();

  const allowed = await app.inject({ method: 'GET', url: '/emails/counts' });
  assert(allowed.statusCode === 200, 'allowed queue → 200');

  const blocked = await app.inject({ method: 'GET', url: '/secret/counts' });
  assert(blocked.statusCode === 404, 'restricted queue → 404');

  await app.close();
}

async function testPrefix() {
  console.log('\n--- Routes: Prefix ---');

  const { app } = await createTestApp({ emails: {} }, { prefix: '/api/queues' });

  const res = await app.inject({
    method: 'POST', url: '/api/queues/emails/jobs',
    payload: { name: 'test', data: {} },
  });
  assert(res.statusCode === 201, 'prefixed route works → 201');

  // Non-prefixed should 404
  const noPrefixRes = await app.inject({ method: 'GET', url: '/emails/counts' });
  assert(noPrefixRes.statusCode === 404, 'non-prefixed route → 404');

  await app.close();
}

async function testSSE() {
  console.log('\n--- SSE Events ---');

  const { app } = await createTestApp({
    emails: { processor: async (job: any) => ({ sent: true }) },
  });

  const address = await app.listen({ port: 0 });

  const { statusCode, contentType, body } = await new Promise<{
    statusCode: number;
    contentType: string;
    body: string;
  }>((resolve, reject) => {
    const req = http.get(`${address}/emails/events`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });

      // Read for 1.5 seconds then close
      setTimeout(() => {
        resolve({
          statusCode: res.statusCode!,
          contentType: res.headers['content-type'] ?? '',
          body,
        });
        res.destroy();
      }, 1500);
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });

  assert(statusCode === 200, `SSE status → 200 (got ${statusCode})`);
  assert(contentType.includes('text/event-stream'), `SSE content-type → text/event-stream`);
  assert(body.includes(':ok'), 'SSE body starts with :ok comment');

  await app.close();
}

async function testDirectRegistryAccess() {
  console.log('\n--- Direct Registry Access ---');

  const { app, registry } = await createTestApp({
    emails: { processor: async (job: any) => ({ sent: true }) },
  });

  // Direct queue access
  const { queue, worker } = registry.get('emails');
  assert(queue !== undefined, 'direct queue access works');
  assert(worker !== undefined, 'worker created for emails');

  // Add job directly
  const job = await queue.add('direct-test', { key: 'value' });
  assert(job !== null && job !== undefined, 'direct queue.add works');

  // Verify via API
  const res = await app.inject({ method: 'GET', url: `/emails/jobs/${job!.id}` });
  assert(res.statusCode === 200, 'job added directly visible via API');

  await app.close();
}

async function testSerializers() {
  console.log('\n--- Serializers ---');

  const { registry } = await createTestApp({ emails: {} });
  const { queue } = registry.get('emails');

  const job = await queue.add('test', { x: 1 });
  if (job) {
    const serialized = serializeJob(job);
    assert(typeof serialized.id === 'string', 'serialized job has id');
    assert(serialized.name === 'test', 'serialized job has name');
    assert(serialized.data !== undefined, 'serialized job has data');
  }

  const jobs = await queue.getJobs('waiting');
  const serialized = serializeJobs(jobs);
  assert(Array.isArray(serialized), 'serializeJobs returns array');
  assert(serialized.length > 0, 'serialized jobs not empty');

  await registry.closeAll();
}

async function testMultiplePluginRegistrations() {
  console.log('\n--- Multiple Registrations ---');

  const app = Fastify();
  await app.register(glideMQPlugin, {
    queues: { emails: {}, reports: {} },
    testing: true,
  });

  // Register routes twice with different prefixes
  await app.register(glideMQRoutes, { prefix: '/v1' });
  await app.register(glideMQRoutes, { prefix: '/v2' });
  await app.ready();

  const v1 = await app.inject({ method: 'GET', url: '/v1/emails/counts' });
  const v2 = await app.inject({ method: 'GET', url: '/v2/emails/counts' });
  assert(v1.statusCode === 200, 'v1 prefix works');
  assert(v2.statusCode === 200, 'v2 prefix works');

  await app.close();
}

async function testCustomRouteWithRegistry() {
  console.log('\n--- Custom Route with Registry ---');

  const app = Fastify();
  await app.register(glideMQPlugin, {
    queues: { emails: { processor: async (job: any) => ({ sent: true }) } },
    testing: true,
  });

  // Custom route that uses the registry
  app.post('/send-email', async (request, reply) => {
    const { to, subject } = request.body as any;
    const { queue } = app.glidemq.get('emails');
    const job = await queue.add('send', { to, subject });
    return reply.send({ jobId: job?.id ?? null });
  });

  await app.register(glideMQRoutes, { prefix: '/api' });
  await app.ready();

  // Use custom route
  const customRes = await app.inject({
    method: 'POST', url: '/send-email',
    payload: { to: 'user@test.com', subject: 'Hello' },
  });
  assert(customRes.statusCode === 200, 'custom route works');
  assert(customRes.json().jobId !== null, 'custom route returns jobId');

  // Verify via API
  const jobId = customRes.json().jobId;
  const apiRes = await app.inject({ method: 'GET', url: `/api/emails/jobs/${jobId}` });
  assert(apiRes.statusCode === 200, 'job visible via API routes');
  assert(apiRes.json().data.to === 'user@test.com', 'job data correct');

  await app.close();
}

// Run all tests
async function main() {
  console.log('=== @glidemq/fastify Smoke Tests ===');

  await testPluginRegistration();
  await testRoutesBasic();
  await testRoutesOperations();
  await testValidation();
  await testRestrictedQueues();
  await testPrefix();
  await testSSE();
  await testDirectRegistryAccess();
  await testSerializers();
  await testMultiplePluginRegistrations();
  await testCustomRouteWithRegistry();

  console.log(`\n=== Results: ${passed.length} passed, ${failed.length} failed ===`);
  if (failed.length > 0) {
    console.error('\nFailed:');
    for (const f of failed) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
