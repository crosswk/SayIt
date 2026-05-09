export type OverlayWaveTheme = 'black-white' | 'black-blue' | 'black-rainbow'

const SINGLE_KEY_MAP: Record<string, string> = {
  AltLeft: 'AltLeft',
  AltRight: 'AltRight',
  ControlLeft: 'ControlLeft',
  ControlRight: 'ControlRight',
  ShiftLeft: 'ShiftLeft',
  ShiftRight: 'ShiftRight',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
  CapsLock: 'CapsLock',
  Space: 'Space',
}

const SINGLE_KEY_DISPLAY: Record<string, string> = {
  AltLeft: '左 Alt',
  AltRight: '右 Alt',
  ControlLeft: '左 Ctrl',
  ControlRight: '右 Ctrl',
  ShiftLeft: '左 Shift',
  ShiftRight: '右 Shift',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
  CapsLock: 'CapsLock',
  Space: '空格',
}

export function cleanMicLabel(label: string): string {
  return label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '').trim()
}

export function resolveSingleKeyShortcut(code: string): string | undefined {
  return SINGLE_KEY_MAP[code]
}

export function getSingleKeyDisplay(value: string): string {
  return SINGLE_KEY_DISPLAY[value] || value
}

export function eventToAccelerator(event: KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  const key = event.key
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null

  const keyMap: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Enter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
  }

  const mapped = keyMap[key] || (key.length === 1 ? key.toUpperCase() : key)
  parts.push(mapped)
  return parts.length >= 2 ? parts.join('+') : null
}

export function displayAccelerator(accelerator: string): string[] {
  return accelerator.split('+').map((part) => {
    const map: Record<string, string> = {
      CommandOrControl: 'Ctrl',
      Alt: 'Alt',
      Shift: 'Shift',
      Space: 'Space',
      Return: 'Enter',
    }
    return map[part] || part
  })
}
