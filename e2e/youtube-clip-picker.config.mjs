import { defineConfig } from '@playwright/test';
import base from '../playwright.config.mjs';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'youtube-clip-picker.spec.ts',
  webServer: { ...base.webServer, cwd: fileURLToPath(new URL('..', import.meta.url)) },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
  ],
});
