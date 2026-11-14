import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/', 'dist/', 'vendor/', 'models/', '.eval-cache/', '.e2e-shots/', 'demo-output/', 'scripts/_*.mjs'],
  },
  js.configs.recommended,
  {
    // Extension code. It all runs in the browser (content script, popup, offscreen page, service worker).
    files: ['background.js', 'content/**/*.js', 'popup/**/*.js', 'offscreen/**/*.js', 'lib/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions, ImageDecoder: 'readonly' },
    },
  },
  {
    files: ['content/**/*.js', 'popup/**/*.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // Puppeteer callbacks run inside extension pages.
    files: ['scripts/e2e.mjs', 'scripts/screenshots.mjs', 'scripts/demo-video.mjs', 'scripts/store-assets.mjs', 'scripts/mp4-to-gif.mjs', 'scripts/web-video.mjs', 'scripts/blur-listings.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.webextensions } },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
];
