interface Props {
  grokFound: boolean
  authenticated: boolean
  hasProject: boolean
  onInstallCli: () => void
  onSignIn: () => void
  onOpenProject: () => void
  onDismiss: () => void
}

/**
 * First-hour path without inventing a second login story. Install and sign-in
 * go through the same CLI-backed flows the rest of the app uses (no baked
 * credentials, no alternate auth).
 */
export function OnboardingChecklist({
  grokFound,
  authenticated,
  hasProject,
  onInstallCli,
  onSignIn,
  onOpenProject,
  onDismiss
}: Props) {
  const steps = [
    {
      id: 'cli',
      done: grokFound,
      title: 'Install the Grok CLI',
      body: 'Gronk runs your local grok binary. Nothing is bundled.',
      actionLabel: 'Install CLI',
      onAction: onInstallCli
    },
    {
      id: 'auth',
      done: authenticated,
      title: 'Sign in with your Grok account',
      body: 'Tokens stay in the CLI on this machine, not in Gronk settings.',
      actionLabel: 'Sign in',
      onAction: onSignIn
    },
    {
      id: 'project',
      done: hasProject,
      title: 'Open a folder to Build',
      body: 'Optional for Chat. Required when you want the coding agent.',
      actionLabel: 'Add project',
      onAction: onOpenProject
    }
  ] as const

  const remaining = steps.filter((s) => !s.done).length
  if (remaining === 0) return null

  return (
    <section className="onboarding" aria-label="Getting started">
      <div className="onboarding-head">
        <div>
          <p className="home-kicker">Getting started</p>
          <h2 className="onboarding-title">Three steps to a working desktop</h2>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
          Hide
        </button>
      </div>
      <ol className="onboarding-list">
        {steps.map((step, i) => (
          <li key={step.id} className={`onboarding-step ${step.done ? 'done' : ''}`}>
            <div className="onboarding-step-mark" aria-hidden>
              {step.done ? '✓' : i + 1}
            </div>
            <div className="onboarding-step-body">
              <div className="onboarding-step-title">{step.title}</div>
              <p className="onboarding-step-copy">{step.body}</p>
              {!step.done ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={step.onAction}>
                  {step.actionLabel}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
