import type { GronkApi } from '../shared/types'

declare global {
  interface Window {
    gronk: GronkApi
  }
}

export {}
