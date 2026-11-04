// Builds the Electron main + preload bundles with esbuild and the renderer with Vite.
// Usage: node scripts/build.mjs [--watch]
import { build, context } from 'esbuild';
import { build as viteBuild } from 'vite';
import { rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'ffmpeg-static', 'ws', 'bufferutil', 'utf-8-validate'],
  alias: { '@shared': resolve(root, 'src/shared') },
  logLevel: 'info',
};

const targets = [
  { ...common, entryPoints: [resolve(root, 'src/main/index.ts')], outfile: resolve(root, 'dist/main/index.js') },
  { ...common, entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(root, 'dist/preload/index.js') },
];

async function run() {
  if (!watch) rmSync(resolve(root, 'dist'), { recursive: true, force: true });
  mkdirSync(resolve(root, 'dist'), { recursive: true });
  if (watch) {
    for (const t of targets) {
      const ctx = await context(t);
      await ctx.watch();
    }
    await viteBuild({ configFile: resolve(root, 'vite.config.ts'), mode: 'development', build: { watch: {} } });
    console.log('Watching for changes. Run "npm start" in another terminal; press Ctrl+R in the app to reload the UI.');
  } else {
    await Promise.all(targets.map((t) => build(t)));
    await viteBuild({ configFile: resolve(root, 'vite.config.ts'), mode: 'production' });
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
