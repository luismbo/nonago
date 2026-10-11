import { defineConfig } from 'vitest/config';

// `base: './'` keeps every asset path relative, so the same build works at
// https://<user>.github.io/ and at https://<user>.github.io/<repo>/.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
