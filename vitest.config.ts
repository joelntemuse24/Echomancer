import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // next-auth imports "next/server" without the .js extension; Node ESM
      // resolution in Vitest needs the explicit file.
      'next/server': path.resolve(__dirname, './node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'dist'],
    setupFiles: ['./src/test/setup-env.ts'],
    server: {
      deps: {
        inline: ['next-auth', '@auth/core'],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        '.next/',
        'dist/',
        '**/*.test.ts',
        '**/*.config.ts',
      ],
    },
  },
});
