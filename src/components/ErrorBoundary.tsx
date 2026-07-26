import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: string | null
}

/**
 * Catches render/lifecycle errors anywhere in the tree so a single thrown error
 * doesn't leave a blank window. Shows the error plus a recover/reload path.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[gronk] render error', error, info.componentStack)
    this.setState({ info: info.componentStack || null })
  }

  private reset = (): void => {
    this.setState({ error: null, info: null })
  }

  private reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    const { error, info } = this.state
    if (!error) return this.props.children

    const detail = [error.stack || String(error), info ? `\nComponent stack:${info}` : '']
      .join('')
      .slice(0, 4000)

    return (
      <div className="crash-screen" role="alert">
        <div className="crash-card">
          <div className="crash-kicker">Gronk hit an error</div>
          <h2>{error.message || 'Unexpected error'}</h2>
          <p className="crash-copy">
            The interface stopped rendering. Your sessions and transcripts are saved on disk — try
            again, or reload the window.
          </p>
          <pre className="crash-detail">{detail}</pre>
          <div className="crash-actions">
            <button type="button" className="btn btn-primary" onClick={this.reset}>
              Try again
            </button>
            <button type="button" className="btn btn-secondary" onClick={this.reload}>
              Reload window
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void navigator.clipboard?.writeText(detail)}
            >
              Copy details
            </button>
          </div>
        </div>
      </div>
    )
  }
}
