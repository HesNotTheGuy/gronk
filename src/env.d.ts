import type { GrockyApi } from '../shared/types'

declare global {
  interface Window {
    grocky: GrockyApi
  }
}

export {}
