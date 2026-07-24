import type { AppSettings } from '../../shared/types'

export function resolveTheme(theme: AppSettings['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return theme
}

export function applyTheme(theme: AppSettings['theme']): void {
  const resolved = resolveTheme(theme)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}
