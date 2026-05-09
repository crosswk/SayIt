import { useSyncExternalStore } from 'react'
import { subscribeConnectionStatus, getConnectionStatus } from '../stores/connectionStatus'

export function useConnectionStatus() {
  return useSyncExternalStore(subscribeConnectionStatus, getConnectionStatus)
}
