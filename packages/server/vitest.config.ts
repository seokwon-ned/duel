import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts'],
    exclude: ['dist/**', 'src/e2e-*.ts', 'src/reconnection.test.ts'],
  },
});
