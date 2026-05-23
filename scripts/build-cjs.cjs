/**
 * scripts/build-cjs.cjs
 *
 * Generates the CommonJS compatibility shim in dist/cjs/ using esbuild.
 * Bundling is intentional: esbuild inlines mimetypes.json and handles
 * import-attribute syntax that tsc cannot emit in CommonJS mode.
 * Node.js built-ins remain external (--platform node).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const esbuild = require(path.join(__dirname, '../node_modules/esbuild'));

const root = path.join(__dirname, '..');
const outdir = path.join(root, 'dist/cjs');

// Ensure the output directory exists (clean is handled by the caller if needed).
fs.mkdirSync(outdir, { recursive: true });

esbuild.build({
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: path.join(outdir, 'index.js'),
  absWorkingDir: root,
  // Keep source code readable for debugging
  minify: false,
  // Allow TypeScript path aliases and import attributes
  logLevel: 'info',
}).then(() => {
  // Write the package.json marker so Node treats this folder as CommonJS,
  // even though the repo root is "type": "module".
  fs.writeFileSync(
    path.join(outdir, 'package.json'),
    '{"type":"commonjs"}\n',
  );
  console.log('CJS build written to dist/cjs/');
}).catch((/** @type {Error} */ err) => {
  console.error('CJS build failed:', err.message);
  process.exit(1);
});
