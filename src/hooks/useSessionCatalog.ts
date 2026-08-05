import { useCallback, useMemo, useState } from 'react'
import type { ProjectContext, ProjectNotes, SessionInfo } from '../../shared/types'
import { isChatSession, isChatWorkspace, isWorkspaceSession } from '../../shared/path'

/**
 * The lists the app browses: stored sessions, recent project folders, and the
 * sliced views over them.
 *
 * `chatWorkspacePath` lives here because it is what separates a workspace
 * session from an app Chat session, and every slice below is defined by that
 * split.
 *
 * What is deliberately NOT here: deleting and archiving the session that is
 * currently live. Those have to clear the conversation and restart the agent, so
 * they stay in the composer next to the state they touch, and reach this hook
 * through `setSessions` / `refreshSessions`.
 */
export function useSessionCatalog() {
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [recentProjects, setRecentProjects] = useState<ProjectContext[]>([])
  const [chatWorkspacePath, setChatWorkspacePath] = useState<string | null>(null)
  /**
   * Project scratchpads, `null` until the first hydrate.
   *
   * Null rather than `{}` because the tray has to tell "this project has no
   * note" from "the notes have not arrived yet". Both show an empty box, but
   * seeding the textarea from the second one and then hydrating underneath it
   * would either wipe what the user had started typing or leave their note
   * invisible until they switched projects.
   */
  const [projectNotes, setProjectNotes] = useState<ProjectNotes | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  /**
   * Write-through for the composer's `refreshMeta`, which reads all three of
   * these in one `Promise.all`.
   */
  const hydrate = useCallback(
    (meta: {
      recentProjects: ProjectContext[]
      sessions: SessionInfo[]
      chatWorkspacePath: string
      projectNotes: ProjectNotes
    }) => {
      setRecentProjects(meta.recentProjects)
      setSessions(meta.sessions)
      setChatWorkspacePath(meta.chatWorkspacePath)
      setProjectNotes(meta.projectNotes)
    },
    []
  )

  /** Re-read the session list after main has changed it. */
  const refreshSessions = useCallback(async () => {
    setSessions(await window.gronk.listSessions())
  }, [])

  const renameSession = useCallback(async (id: string, title: string) => {
    await window.gronk.renameSession(id, title)
    const sess = await window.gronk.listSessions()
    setSessions(sess)
  }, [])

  /** Put an archived session back into the normal lists. */
  const unarchiveSession = useCallback(async (id: string) => {
    await window.gronk.archiveSession(id, false)
    const sess = await window.gronk.listSessions()
    setSessions(sess)
  }, [])

  /** Forget a folder from the rail. Never deletes files. */
  const removeRecentProject = useCallback(async (cwd: string) => {
    setRecentProjects(await window.gronk.removeRecentProject(cwd))
  }, [])

  const setRecentProjectPinned = useCallback(async (cwd: string, pinned: boolean) => {
    setRecentProjects(await window.gronk.setRecentProjectPinned(cwd, pinned))
  }, [])

  /**
   * Save one project's scratchpad. Main returns the whole map, so the write is
   * write-through and no re-read is needed.
   *
   * Takes the text already normalized: what to do with whitespace is a decision
   * with tests behind it (`src/lib/project-notes.ts`), not something to repeat
   * at each call site.
   */
  const setProjectNote = useCallback(async (cwd: string, note: string) => {
    setProjectNotes(await window.gronk.setProjectNote(cwd, note))
  }, [])

  const uniqueSessions = useMemo(() => {
    const seen = new Set<string>()
    const out: SessionInfo[] = []
    for (const s of sessions) {
      if (!s.id || seen.has(s.id)) continue
      seen.add(s.id)
      out.push(s)
    }
    return out
  }, [sessions])

  const activeSessions = useMemo(
    () => uniqueSessions.filter((s) => !s.archived),
    [uniqueSessions]
  )

  /** Hidden from every normal list: only the Archived panel reads this. */
  const archivedSessions = useMemo(
    () =>
      uniqueSessions
        .filter((s) => s.archived)
        .sort((a, b) => (b.archivedAt || b.updatedAt) - (a.archivedAt || a.updatedAt)),
    [uniqueSessions]
  )

  const chatSessions = useMemo(
    () => activeSessions.filter((s) => isChatSession(s, chatWorkspacePath)),
    [activeSessions, chatWorkspacePath]
  )

  /**
   * Workspace (folder) sessions only.
   * App Chat is stored under userData/chat-workspace and never listed here.
   */
  const projectOnlySessions = useMemo(
    () => activeSessions.filter((s) => isWorkspaceSession(s, chatWorkspacePath)),
    [activeSessions, chatWorkspacePath]
  )

  /** Workspace folders only: strip chat sandbox if it ever landed in recent */
  const workspaceProjects = useMemo(
    () => recentProjects.filter((p) => !isChatWorkspace(p.cwd, chatWorkspacePath)),
    [recentProjects, chatWorkspacePath]
  )

  return {
    sessions: uniqueSessions,
    recentProjects: workspaceProjects,
    chatSessions,
    /** Folder agent sessions only (never app Chat) */
    projectOnlySessions,
    archivedSessions,
    chatWorkspacePath,
    showArchived,
    setShowArchived,
    renameSession,
    unarchiveSession,
    removeRecentProject,
    setRecentProjectPinned,
    projectNotes,
    setProjectNote,
    // For the composer only. Not part of the app's public surface.
    hydrate,
    refreshSessions,
    setSessions,
    setChatWorkspacePath
  }
}
