/**
 * dsh-qqmail post-build: the two `bin` entries are plain ESM bundles emitted by
 * tsdown, which does not guarantee a shebang survives bundling. Add it when
 * missing and mark both executables, so `qqmail` / `qqmail-mcp` are runnable
 * from any shell (and from other agents) right after `npm i -g` / `dsh plugin add`.
 */
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bins = ['lib/cli.js', 'lib/mcp-server.js']
const SHEBANG = '#!/usr/bin/env node\n'

for (const relative of bins) {
  const file = path.join(root, relative)
  if (!existsSync(file)) {
    console.error('[postbuild] missing ' + relative + ' — did the tsdown entry get renamed?')
    process.exitCode = 1
    continue
  }
  let source = await readFile(file, 'utf8')
  if (!source.startsWith('#!')) {
    source = SHEBANG + source
    await writeFile(file, source)
  }
  await chmod(file, 0o755)
  console.log('[postbuild] ' + relative + ' ready (shebang + 755)')
}
