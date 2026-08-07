import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangedFile, FileDiff, WorkingTreeChanges } from '../../shared/types'
import { diffLineTone, shortPath, statusLabel } from '../lib/git-changes'

interface Props {
  /** Bumped by the host when the panel becomes visible, to trigger the first read. */
  visibleKey: number
  onCount?: (count: number | null) => void
}

/**
 * What the agent has changed in this folder.
 *
 * Reads on demand only: once when the panel is opened, and again when Refresh is
 * pressed. Never on a render, never on a keystroke, never on a timer. Each read
 * is a real subprocess, and the question is not one that needs answering while
 * nobody is looking at it.
 *
 * Diff text is rendered as inert text, one span per line. It is file content,
 * which means it is whatever the agent or the repository put there, so it does
 * not go near the markdown pipeline and nothing in it becomes a link.
 *
 * Nothing here is persisted. The result lives in this component's state and is
 * gone when the panel closes, which is the whole of its lifetime by design.
 */
export function ChangesPanel({ visibleKey, onCount }: Props) {
  const [changes, setChanges] = useState<WorkingTreeChanges | null>(null)
  const [selected, setSelected] = useState<ChangedFile | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const report = useRef(onCount)
  report.current = onCount
  /**
   * Which request the panel is showing. Each read costs a subprocess and they
   * do not finish in the order they were started, so without this a slow diff
   * for one file lands after a fast one for another and the pane shows one
   * file's contents under a different file's name.
   */
  const request = useRef(0)

  const refresh = useCallback(async () => {
    const ticket = ++request.current
    setLoading(true)
    try {
      const next = await window.gronk.getGitChanges()
      if (ticket !== request.current) return
      setChanges(next)
      setSelected(null)
      setDiff(null)
      setDiffError(null)
      report.current?.(next.repo ? next.files.length : null)
    } catch (err) {
      if (ticket !== request.current) return
      // A rejected invoke would otherwise leave the panel reading "Reading the
      // working tree..." forever, which looks like a hang rather than a failure.
      setChanges({
        repo: true,
        reason: 'git-failed',
        message: err instanceof Error ? err.message : String(err),
        files: [],
        truncated: false
      })
      report.current?.(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // One read per time the panel is shown. `visibleKey` changes when the host
  // opens it, which is the only thing that should start a subprocess.
  useEffect(() => {
    void refresh()
  }, [visibleKey, refresh])

  const select = useCallback(async (file: ChangedFile) => {
    const ticket = ++request.current
    setSelected(file)
    setDiff(null)
    setDiffError(null)
    try {
      const result = await window.gronk.getGitFileDiff(file.path)
      if (ticket !== request.current) return
      if ('error' in result) {
        setDiffError(result.error)
        return
      }
      setDiff(result)
    } catch (err) {
      if (ticket !== request.current) return
      setDiffError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const head = (
    <div className="changes-head">
      <span className="changes-title">Working tree</span>
      <button
        type="button"
        className="btn-mini"
        onClick={() => void refresh()}
        disabled={loading}
        title="Read the working tree again"
      >
        {loading ? 'Reading…' : 'Refresh'}
      </button>
    </div>
  )

  if (!changes) {
    return (
      <div className="changes-panel">
        {head}
        <p className="changes-note">Reading the working tree…</p>
      </div>
    )
  }

  if (!changes.repo) {
    return (
      <div className="changes-panel">
        {head}
        <p className="changes-note">
          {changes.reason === 'no-folder'
            ? 'No project folder is open, so there is nothing to compare.'
            : changes.reason === 'not-a-repo'
              ? 'This folder is not a git repository, so there is no working tree to read.'
              : changes.message || 'git could not read this folder.'}
        </p>
      </div>
    )
  }

  return (
    <div className="changes-panel">
      {head}

      {changes.files.length === 0 ? (
        <p className="changes-note">Nothing has changed in this folder.</p>
      ) : (
        <div className="changes-body">
          <div className="changes-list">
            {changes.files.map((file) => (
              <button
                key={`${file.status}:${file.path}`}
                type="button"
                className={`changes-row ${selected?.path === file.path ? 'active' : ''}`}
                onClick={() => void select(file)}
                title={file.path}
              >
                <span className={`changes-status ${file.status}`}>{statusLabel(file.status)}</span>
                <span className="changes-path">{shortPath(file.path)}</span>
              </button>
            ))}
            {changes.truncated ? (
              <p className="changes-note">
                More files changed than are listed here. Showing the first {changes.files.length}.
              </p>
            ) : null}
          </div>

          <div className="changes-diff">
            {!selected ? (
              <p className="changes-note">Pick a file to see what changed.</p>
            ) : diffError ? (
              <p className="changes-note">{diffError}</p>
            ) : !diff ? (
              <p className="changes-note">Reading…</p>
            ) : diff.binary ? (
              <p className="changes-note">This file is binary, so there is no text to show.</p>
            ) : (
              <>
                {/*
                  A <pre> of spans, never markdown and never an anchor. Diff text
                  is file content, so it is untrusted by definition.
                */}
                <pre className="diff-text">
                  {diff.text.split('\n').map((line, i) => (
                    <span key={i} className={`diff-line ${diffLineTone(line)}`}>
                      {line}
                      {'\n'}
                    </span>
                  ))}
                </pre>
                {diff.truncated ? (
                  <p className="changes-note">
                    This diff is longer than the panel will show, and was cut here.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
