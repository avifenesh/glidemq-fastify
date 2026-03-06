import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import { buildTestApp } from './helpers/test-app';

describe('SSE events (testing mode)', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('returns SSE content-type', async () => {
    const { app } = await buildTestApp({
      emails: {
        processor: async (_job: any) => ({ sent: true }),
      },
    });

    // SSE requires a real HTTP connection since inject() waits for res.end()
    const address = await app.listen({ port: 0 });
    cleanup = () => app.close();

    const { statusCode, contentType } = await new Promise<{ statusCode: number; contentType: string }>(
      (resolve, reject) => {
        const req = http.get(`${address}/emails/events`, (res) => {
          resolve({
            statusCode: res.statusCode!,
            contentType: res.headers['content-type'] ?? '',
          });
          res.destroy(); // Close immediately, we only need headers
        });
        req.on('error', reject);
        req.setTimeout(5000, () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
      },
    );

    expect(statusCode).toBe(200);
    expect(contentType).toContain('text/event-stream');
  });

  it('returns 404 for unconfigured queue', async () => {
    const { app } = await buildTestApp({ emails: {} });
    cleanup = () => app.close();

    const res = await app.inject({
      method: 'GET',
      url: '/unknown/events',
    });
    expect(res.statusCode).toBe(404);
  });
});
