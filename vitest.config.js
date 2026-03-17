const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root: 'tests',
    include: ['**/*.test.js', '**/*.test.mjs'],
    exclude: ['**/e2e/**', '**/integration/**'],
    setupFiles: ['./setup.mjs'],
  },
});
