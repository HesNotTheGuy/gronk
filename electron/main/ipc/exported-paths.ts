import fs from 'node:fs'
import path from 'node:path'

/**
 * Paths the user picked in an export save dialog during THIS run.
 *
 * An exported transcript normally lands in ~/Documents, which is deliberately
 * not an allowed root — widening the roots to cover it would grant reveal access
 * to every file there. Instead each path is consented individually at the moment
 * the user chose it in a native dialog, and the consent dies with the process.
 * Bounded so a long session cannot grow it without limit.
 *
 * The array is module-private on purpose: the transcript export handler and the
 * reveal handler live in different modules, and both must go through these two
 * functions rather than share a mutable list.
 */
const MAX_REMEMBERED_EXPORTS = 50
const exportedPaths: string[] = []

export function rememberExportedPath(filePath: string): void {
  let real: string
  try {
    real = fs.realpathSync(filePath)
  } catch {
    real = path.resolve(filePath)
  }
  if (exportedPaths.includes(real)) return
  exportedPaths.push(real)
  if (exportedPaths.length > MAX_REMEMBERED_EXPORTS) exportedPaths.shift()
}

export function isConsentedExportPath(resolved: string): boolean {
  return exportedPaths.includes(resolved)
}
