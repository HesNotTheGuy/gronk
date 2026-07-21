import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type ProjectContext,
  type SessionInfo
} from '../../shared/types'

interface StoreData {
  settings: AppSettings
  recentProjects: ProjectContext[]
  sessions: SessionInfo[]
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'grocky-store.json')
}

function readStore(): StoreData {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8')
    const data = JSON.parse(raw) as Partial<StoreData>
    return {
      settings: { ...DEFAULT_SETTINGS, ...data.settings },
      recentProjects: data.recentProjects ?? [],
      sessions: data.sessions ?? []
    }
  } catch {
    return {
      settings: { ...DEFAULT_SETTINGS },
      recentProjects: [],
      sessions: []
    }
  }
}

function writeStore(data: StoreData): void {
  const dir = path.dirname(storePath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8')
}

export function getSettings(): AppSettings {
  return readStore().settings
}

export function setSettings(partial: Partial<AppSettings>): AppSettings {
  const data = readStore()
  data.settings = { ...data.settings, ...partial }
  writeStore(data)
  return data.settings
}

export function getRecentProjects(): ProjectContext[] {
  return readStore().recentProjects
}

export function addRecentProject(cwd: string): ProjectContext[] {
  const data = readStore()
  const name = path.basename(cwd) || cwd
  const entry: ProjectContext = { cwd, name }
  data.recentProjects = [
    entry,
    ...data.recentProjects.filter((p) => p.cwd !== cwd)
  ].slice(0, 12)
  writeStore(data)
  return data.recentProjects
}

export function listSessions(): SessionInfo[] {
  return readStore().sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function upsertSession(session: SessionInfo): void {
  const data = readStore()
  const idx = data.sessions.findIndex((s) => s.id === session.id)
  if (idx >= 0) data.sessions[idx] = session
  else data.sessions.unshift(session)
  data.sessions = data.sessions.slice(0, 50)
  writeStore(data)
}
