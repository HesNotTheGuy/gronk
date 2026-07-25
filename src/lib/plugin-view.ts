/**
 * Pure view logic for the Plugins & Skills surface.
 *
 * Everything here operates on third-party marketplace catalog data, which is
 * UNTRUSTED. Kept out of the .tsx components so `npm test` can cover the
 * sanitizer and the risk audit without a DOM.
 */

import type { Plugin, PluginComponent } from '../../shared/types'

export interface ComponentCounts {
  skills: number
  commands: number
  agents: number
  mcp: number
  hooks: number
}

/**
 * Counts derived from `components.*` only.
 * The flat `skill_count` / `has_*` summary fields are unreliable for
 * `status: "available"` catalog entries (SKILLS-PLUGINS-SPEC §1) — never read them.
 */
export function componentCounts(plugin: Plugin): ComponentCounts {
  const c = plugin?.components
  return {
    skills: c?.skills?.length || 0,
    commands: c?.commands?.length || 0,
    agents: c?.agents?.length || 0,
    mcp: c?.mcpServers?.length || 0,
    hooks: c?.hooks?.length || 0
  }
}

/** C0/C1 controls, zero-width joiners and bidi overrides — used to disguise catalog text. */
function isUnsafeChar(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/**
 * Every plugin/skill/component string comes from a third-party marketplace catalog and is
 * UNTRUSTED. It is rendered as inert plain text — never markdown, never HTML, never as
 * instructions. Collapses whitespace and strips control / bidi-override characters.
 */
export function plainText(value: string | null | undefined, max = 260): string {
  if (typeof value !== 'string') return ''
  let cleaned = ''
  for (const ch of value) {
    cleaned += isUnsafeChar(ch.codePointAt(0) || 0) ? ' ' : ch
  }
  const flat = cleaned.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** `name — description` for a catalog component, all plain text. */
export function componentLine(item: PluginComponent): string {
  const name = plainText(item?.name, 80) || 'unnamed'
  const desc = plainText(item?.description, 180)
  return desc ? `${name} — ${desc}` : name
}

export type RiskSeverity = 'HIGH' | 'MED' | 'INFO'

export interface RiskTag {
  severity: RiskSeverity
  label: string
  detail: string
}

/**
 * Static audit of the catalog-declared components (SKILLS-PLUGINS-SPEC §4.3).
 * Fails safe: an MCP server with an unrecognised transport is treated as shell-exec.
 */
export function auditPlugin(plugin: Plugin): RiskTag[] {
  const tags: RiskTag[] = []
  const servers = plugin?.components?.mcpServers || []
  const hooks = plugin?.components?.hooks || []
  const skills = plugin?.components?.skills || []

  const remote = servers.filter((s) => {
    const t = plainText(s?.description, 24).toLowerCase()
    return t === 'http' || t === 'sse'
  })
  const local = servers.filter((s) => !remote.includes(s))

  if (local.length > 0) {
    tags.push({
      severity: 'HIGH',
      label: `Shell-exec MCP server (${local.length})`,
      detail: 'Runs a local program on your machine whenever the agent starts.'
    })
  }
  if (remote.length > 0) {
    tags.push({
      severity: 'MED',
      label: `Remote MCP server (${remote.length})`,
      detail: 'Sends your prompts and tool data to a remote endpoint.'
    })
  }
  if (hooks.length > 0) {
    tags.push({
      severity: 'HIGH',
      label: `Hooks (${hooks.length})`,
      detail: "Hooks run shell commands around tool calls, outside Grocky's file protections."
    })
    const broad = hooks.filter((h) => !plainText(h?.description, 40))
    if (broad.length > 0) {
      tags.push({
        severity: 'HIGH',
        label: `Over-broad hook (${broad.length})`,
        detail: 'Declares no matcher — fires unconditionally on every matching event.'
      })
    }
  }
  if (skills.length > 0) {
    tags.push({
      severity: 'MED',
      label: `Skills (${skills.length})`,
      detail:
        'Skill text is injected into the agent as instructions — a prompt-injection surface. Grocky shows it as inert text.'
    })
  }
  return tags
}

/**
 * What `grok plugin install <SOURCE>` receives. Never derived from free-form catalog prose.
 *
 * `<SOURCE>` must be a git URL, a `user/repo` shorthand, or a local path — verified against
 * `grok plugin install --help` on 0.2.111. There is NO install-by-name form, so a plugin
 * name is not a usable source: the CLI would read it as a path or a repo shorthand and
 * install the wrong thing, or nothing. Returning '' instead leaves the trust modal's
 * confirm button disabled, which is the honest outcome when Grocky cannot name a target.
 *
 * For a catalog entry that declares its own repository, `sourceUrl` is that repository —
 * the same one the pinned commit refers to. Entries that declare none fall back to the
 * marketplace repo URL, which installs from the marketplace rather than the plugin's
 * upstream; that asymmetry is why the trust modal shows the source it is about to use.
 */
export function installSource(plugin: Plugin): string {
  const url = typeof plugin?.sourceUrl === 'string' ? plugin.sourceUrl.trim() : ''
  return url
}
