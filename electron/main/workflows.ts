/**
 * Saved Grok Build Workflows on disk.
 *
 * The CLI has no `grok workflow` subcommand and no stdio ACP list method
 * (verified against grok 1.0.13: `x.ai/workflows/list` is Method not found).
 * The honest catalog is the same directories the CLI scans:
 * project `.grok/workflows/*.rhai` and user `~/.grok/workflows/*.rhai`.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { isPathInside } from './ipc-guard'
import { grokHome } from './grok-home'
import { redactSecrets } from './redact'
import { parseWorkflowMeta, workflowNameFromFilename } from './plugins-map'
import type { SavedWorkflow, WorkflowSource } from '../../shared/types'

const MAX_WORKFLOWS = 400
const MAX_WORKFLOW_FILE_BYTES = 1_000_000

/**
 * `/deep-research` as advertised on `initialize._meta.availableCommands`
 * against grok 1.0.13. Other built-ins live inside the binary and are not
 * listed from disk.
 */
export const BUILTIN_WORKFLOWS: readonly SavedWorkflow[] = [
  {
    name: 'deep-research',
    description:
      'Research with bounded parallel agents, cross-check evidence, and write a cited report',
    source: 'builtin',
    path: 'built-in',
    slash: '/deep-research'
  }
]

export interface ListSavedWorkflowsOptions {
  userDir: string
  /** Absolute project root. `.grok/workflows` is resolved inside this jail. */
  projectRoot?: string | null
}

export async function listSavedWorkflows(
  opts: ListSavedWorkflowsOptions
): Promise<SavedWorkflow[]> {
  const out: SavedWorkflow[] = []
  const seen = new Set<string>()

  for (const builtin of BUILTIN_WORKFLOWS) {
    seen.add(builtin.name.toLowerCase())
    out.push({ ...builtin })
  }

  const roots: Array<{ dir: string; source: Exclude<WorkflowSource, 'builtin'>; jail?: string }> =
    []
  if (opts.projectRoot) {
    const root = path.resolve(opts.projectRoot)
    roots.push({
      dir: path.join(root, '.grok', 'workflows'),
      source: 'project',
      jail: root
    })
  }
  roots.push({ dir: opts.userDir, source: 'user', jail: opts.userDir })

  for (const { dir, source, jail } of roots) {
    const listed = await readWorkflowDir(dir, source, jail)
    for (const item of listed) {
      if (out.length >= MAX_WORKFLOWS) return out
      const key = item.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  return out
}

export async function listWorkflows(projectCwd?: string): Promise<SavedWorkflow[]> {
  return listSavedWorkflows({
    userDir: path.join(grokHome(), 'workflows'),
    projectRoot: projectCwd || undefined
  })
}

async function readWorkflowDir(
  dir: string,
  source: Exclude<WorkflowSource, 'builtin'>,
  jail: string | undefined
): Promise<SavedWorkflow[]> {
  const realJail = await realpathOrNull(jail ?? dir)
  if (!realJail) return []
  const realDir = await realpathOrNull(dir)
  if (!realDir) return []
  if (!isPathInside(realJail, realDir)) return []

  const entries = await fs.readdir(realDir, { withFileTypes: true }).catch(() => [])
  const out: SavedWorkflow[] = []
  for (const entry of entries) {
    if (out.length >= MAX_WORKFLOWS) break
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!entry.name.toLowerCase().endsWith('.rhai')) continue
    const fromName = workflowNameFromFilename(entry.name)
    if (!fromName) continue

    const candidate = path.join(realDir, entry.name)
    const realFile = await realpathOrNull(candidate)
    if (!realFile) continue
    if (!isPathInside(realDir, realFile)) continue

    const stat = await fs.stat(realFile).catch(() => null)
    if (!stat?.isFile() || stat.size > MAX_WORKFLOW_FILE_BYTES) continue

    const text = await fs.readFile(realFile, 'utf8').catch(() => null)
    const parsed = text ? parseWorkflowMeta(text) : null
    const name = parsed?.name || fromName
    const description = parsed?.description
      ? redactSecrets(parsed.description).slice(0, 400)
      : undefined

    out.push({
      name,
      ...(description ? { description } : {}),
      source,
      path: displayPath(source, entry.name),
      slash: `/${name}`
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function displayPath(source: Exclude<WorkflowSource, 'builtin'>, filename: string): string {
  return source === 'user' ? `~/.grok/workflows/${filename}` : `.grok/workflows/${filename}`
}

async function realpathOrNull(target: string): Promise<string | null> {
  return fs.realpath(target).catch(() => null)
}
