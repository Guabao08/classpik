import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // node:sqlite is still flagged experimental; the warning is noise in test output.
    env: { NODE_NO_WARNINGS: '1' },
  },
})
