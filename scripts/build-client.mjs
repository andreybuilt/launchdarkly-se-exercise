// scripts/build-client.mjs
//
// Bundles src/client.mjs (which imports @launchdarkly/js-client-sdk) into
// public/bundle.js using esbuild. This means the browser SDK ships from
// our own origin, no LaunchDarkly CDN script tag at runtime. Run
// automatically by `npm start` / `npm run dev`, or directly with
// `npm run build:client`.

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

await build({
  entryPoints: [path.join(root, 'src', 'client.mjs')],
  outfile: path.join(root, 'public', 'bundle.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  logLevel: 'info',
});
