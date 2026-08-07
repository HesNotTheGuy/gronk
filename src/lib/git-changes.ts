/**
 * Presentation decisions for the working-tree view: what a change is called,
 * how a long path is shortened, and which tone a diff line takes.
 *
 * Pure and here rather than in the component so `node --test` can reach them,
 * the same split every other testable renderer helper in this directory uses.
 * No colours: a diff line reports a tone as a class and `styles.css` owns what
 * that looks like.
 */

import type { ChangeStatus } from '../../shared/types'

/** Two letters, because the column has to stay narrow next to a path. */
export function statusLabel(status: ChangeStatus): string {
  switch (status) {
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'untracked':
      return 'U'
    case 'renamed':
      return 'R'
    case 'conflicted':
      return '!'
    default:
      return 'M'
  }
}

/**
 * A path that fits, keeping the end.
 *
 * The filename and its immediate parent are what identify a file; the segments
 * above it are shared by everything else in the list and are the first thing a
 * reader skips. Truncating from the left keeps the part being read.
 */
export function shortPath(filePath: string, max = 44): string {
  if (filePath.length <= max) return filePath
  const segments = filePath.split('/')
  const tail: string[] = []
  let length = 0
  for (let i = segments.length - 1; i >= 0; i--) {
    const next = length + segments[i].length + (tail.length ? 1 : 0)
    if (next > max - 1 && tail.length) break
    tail.unshift(segments[i])
    length = next
  }
  return tail.length === segments.length ? filePath : `…/${tail.join('/')}`
}

/**
 * The tone of one diff line.
 *
 * `+++` and `---` are file headers rather than an added or removed line, and
 * checking them first is the whole subtlety here: they start with the same
 * character as the lines they must not be confused with, and every unified diff
 * begins with a pair of them.
 */
export function diffLineTone(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return ''
}
