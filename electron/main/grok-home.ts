/**
 * Where the Grok CLI keeps its own state: auth.json, sessions, the marketplace
 * git caches and config.toml.
 *
 * One definition on purpose — this used to be copied verbatim into auth.ts and
 * plugins.ts, and two modules disagreeing about where the CLI's home is would
 * make Grocky read credentials from one place and plugin caches from another.
 * `GROK_HOME` is the CLI's own override, so honouring it keeps Grocky pointed at
 * whatever install the user is actually running.
 */

import os from 'node:os'
import path from 'node:path'

export function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok')
}
