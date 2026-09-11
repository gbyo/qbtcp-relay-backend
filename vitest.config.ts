import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

/**
 * Tests run inside `workerd`, the real Workers runtime, against the real `wrangler.jsonc`.
 *
 * Not a mock: the Durable Object's SQLite, the WebSocket hibernation API, and the router all behave
 * here the way they behave in production. A relay that holds a tournament's finals while Director
 * is away is not something to verify against a hand-written fake.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          RELAY_SETUP_TOKEN: 'test-setup-token',
          RELAY_ALLOWED_ORIGINS: 'https://qbsheet.com,https://scorer.example,https://director.example',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
