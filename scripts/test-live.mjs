/**
 * Runs the opt-in live-CLI contract suite against the real Grok binary.
 *
 * A plain npm script cannot set an env var portably (`VAR=1 cmd` is POSIX,
 * `set VAR=1&&` is cmd.exe), and the repo takes no new dependencies, so this
 * sets it and re-spawns. Everything else about the run matches `npm test`.
 */
import { spawn } from 'node:child_process'

const child = spawn(
  process.execPath,
  [
    '--test',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--import',
    './tests/ts-loader.mjs',
    'tests/live-cli.test.ts'
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, GRONK_LIVE_CLI: '1' }
  }
)

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1))
})
