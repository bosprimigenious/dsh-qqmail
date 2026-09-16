/**
 * dsh-qqmail — DeepSeek Harness home resolution.
 *
 * The plugin owns `<DSH_HOME>/dsh-qqmail.json` (mode 0600, the mailbox
 * credentials live here) and the `<DSH_HOME>/dsh-qqmail/` scratch directory
 * (connection log, cached mailbox list). Neither may be derived from a
 * hardcoded `~/.dsh`.
 *
 * Resolution order (per the DSH plugin portability checklist):
 *   1. the plugin's own override — a full path, used by tests / throwaway
 *      instances / per-plugin relocation;
 *   2. `DSH_HOME` — a launcher or a rescue capsule may relocate the whole
 *      home, and the host sets `DSH_HOME` before loading plugins;
 *   3. `~/.dsh` — the conventional machine-wide location.
 *
 * Hardcoding `~/.dsh` silently writes a second, wrong home on a relocated
 * setup (the plugin then "loses" its mailbox config), so all owned paths go
 * through here.
 */

import { homedir } from 'node:os'
import path from 'node:path'

/** The harness home directory: `DSH_HOME` when set (non-empty), else ~/.dsh. */
export function dshHome(): string {
  const shared = (process.env.DSH_HOME ?? '').trim()
  return shared !== '' ? shared : path.join(homedir(), '.dsh')
}

/**
 * Resolve one owned path under the harness home.
 * @param override - the plugin-specific override (empty/undefined = not set).
 * @param segments - path segments below the home, e.g. `'dsh-qqmail.json'`.
 * @returns the override when set, else `<home>/<segments…>`.
 */
export function pluginPath(override: string | undefined, ...segments: string[]): string {
  const own = (override ?? '').trim()
  return own !== '' ? own : path.join(dshHome(), ...segments)
}
