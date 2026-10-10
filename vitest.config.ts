import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { fileParallelism: false, projects: [
  { test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' } },
  { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node', testTimeout: 30_000, hookTimeout: 60_000 } },
] } });
