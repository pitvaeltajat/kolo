import { defineConfig } from 'vitest/config';

// Node environment: every test here is pure logic (signing, schedule maths).
// No DOM, no Prisma — those need a database and belong in e2e, not unit tests.
export default defineConfig({
  // Inline (empty) PostCSS so Vitest doesn't try to load the app's Tailwind
  // postcss.config.mjs, whose string-plugin form Vite can't parse. Tests are
  // pure logic — no CSS involved.
  css: { postcss: { plugins: [] } },
  test: { environment: 'node', include: ['lib/**/*.test.ts'] },
});
