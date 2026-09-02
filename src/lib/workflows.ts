/**
 * Slash lines for Grok Build Workflows.
 *
 * There is no stdio ACP method for pause/resume/stop/runs (verified against
 * grok 1.0.13). The honest control path is the same text the TUI sends.
 */

export const WORKFLOW_RUN_COMMAND = '/workflow runs'

export const WORKFLOW_MANAGE_VERBS = ['pause', 'resume', 'stop', 'save'] as const

export type WorkflowManageVerb = (typeof WORKFLOW_MANAGE_VERBS)[number]

/** Insert into the composer. Verbs that need a run handle keep a trailing space. */
export function workflowManageCommand(verb: WorkflowManageVerb | 'runs'): string {
  if (verb === 'runs') return WORKFLOW_RUN_COMMAND
  return `/workflow ${verb} `
}

export function savedWorkflowCommand(name: string): string {
  return `/${name} `
}
