// Lightweight global connection status store (no external deps)
// Uses useSyncExternalStore pattern for React integration

import type { WSState } from '../services/websocket'

type Listener = () => void

let currentState: WSState = 'disconnected'
const listeners = new Set<Listener>()

function emitChange() {
  for (const listener of listeners) listener()
}

export function setConnectionStatus(state: WSState) {
  if (currentState === state) return
  currentState = state
  emitChange()
}

export function getConnectionStatus(): WSState {
  return currentState
}

export function subscribeConnectionStatus(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
