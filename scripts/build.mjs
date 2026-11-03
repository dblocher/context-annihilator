// Bundles each Lambda handler and the Claude Code hook into single ESM files.
// SAM deploys the prebuilt directories directly (no `sam build` step).
import { build } from 'esbuild'
import { rm, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const functions = ['ingress', 'coordinator', 'decision-worker', 'result']

// ESM bundles that inline CommonJS dependencies need a real `require`.
const requireShim = "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  mainFields: ['module', 'main'],
  sourcemap: true,
  legalComments: 'none',
  banner: { js: requireShim },
  logLevel: 'warning',
  metafile: true,
}

async function bundle(entry, outfile) {
  const result = await build({ ...common, entryPoints: [join(root, entry)], outfile: join(root, outfile) })
  const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0
  console.log(`${outfile}  ${(bytes / 1024).toFixed(0)} KiB`)
}

await rm(join(root, 'dist'), { recursive: true, force: true })
await rm(join(root, 'claude-plugin', 'dist'), { recursive: true, force: true })

for (const name of functions) {
  await mkdir(join(root, 'dist', 'functions', name), { recursive: true })
  await bundle(`src/functions/${name}/handler.ts`, `dist/functions/${name}/index.mjs`)
}

await mkdir(join(root, 'claude-plugin', 'dist'), { recursive: true })
await bundle('src/hosts/claude-code/hook.ts', 'claude-plugin/dist/annihilate-hook.mjs')
