export type TextInsertionStrategy =
  | 'renderer_dom'
  | 'value_pattern'
  | 'wm_paste'
  | 'send_unicode'
  | 'send_input'

export interface TextInsertionAttempt {
  strategy: TextInsertionStrategy
  ok: boolean
  reason?: string
  detail?: string
}

export interface TextInsertionResult {
  ok: boolean
  strategy?: TextInsertionStrategy
  reason?: string
  detail?: string
  attempts?: TextInsertionAttempt[]
}

interface CaptureOptions {
  preserveExistingOnFailure?: boolean
}

type InsertionSource = 'active' | 'captured'

let capturedTarget: HTMLElement | null = null
let capturedTargetDetail = ''
let targetTrackingStarted = false
let removeTargetTrackingListeners: Array<() => void> = []

function buildResult(
  result: TextInsertionResult,
  attempt?: TextInsertionAttempt,
): TextInsertionResult {
  if (!attempt) return result
  return {
    ...result,
    attempts: [attempt],
  }
}

function dispatchTextInputEvent(target: HTMLElement, text: string) {
  try {
    target.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      data: text,
      inputType: 'insertText',
    }))
    return
  } catch {
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

function describeElement(element: Element | null): string {
  if (!element) return 'element=null'
  const tag = element.tagName.toLowerCase()
  const parts = [`tag=${tag}`]
  if (element instanceof HTMLInputElement) {
    parts.push(`type=${element.type || 'text'}`)
  } else if (element instanceof HTMLTextAreaElement) {
    parts.push('type=textarea')
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    parts.push('contenteditable=1')
  }
  if (element instanceof HTMLElement && element.id) {
    parts.push(`id=${element.id}`)
  }
  return parts.join(' ')
}

function getDeepActiveElement(root: Document | ShadowRoot = document): Element | null {
  let active: Element | null = root.activeElement
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement
  }
  return active
}

function getValueSetter(element: HTMLInputElement | HTMLTextAreaElement) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    'value',
  )
  return descriptor?.set
}

function withDetailPrefix(
  result: TextInsertionResult,
  prefix: string,
): TextInsertionResult {
  if (!prefix) return result
  return {
    ...result,
    detail: result.detail ? `${prefix} ${result.detail}` : prefix,
    attempts: result.attempts?.map((attempt, index) => (index === 0
      ? {
        ...attempt,
        detail: attempt.detail ? `${prefix} ${attempt.detail}` : prefix,
      }
      : attempt)),
  }
}

function insertIntoTextControl(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  source: InsertionSource,
): TextInsertionResult {
  const start = element.selectionStart ?? element.value.length
  const end = element.selectionEnd ?? element.value.length
  const nextValue = `${element.value.slice(0, start)}${text}${element.value.slice(end)}`
  const valueSetter = getValueSetter(element)

  if (valueSetter) {
    valueSetter.call(element, nextValue)
  } else {
    element.value = nextValue
  }

  const caret = start + text.length
  try {
    element.setSelectionRange(caret, caret)
  } catch {
    // Some input types do not support selection APIs.
  }

  dispatchTextInputEvent(element, text)

  return buildResult({
    ok: true,
    strategy: 'renderer_dom',
    detail: `source=${source} ${describeElement(element)}`,
  }, {
    strategy: 'renderer_dom',
    ok: true,
    detail: `source=${source} ${describeElement(element)}`,
  })
}

function findContentEditableTarget(active: Element | null): HTMLElement | null {
  if (active instanceof HTMLElement && active.isContentEditable) {
    return active
  }
  if (active instanceof HTMLElement) {
    const closest = active.closest('[contenteditable=""], [contenteditable="true"]')
    if (closest instanceof HTMLElement) {
      return closest
    }
  }

  const selection = window.getSelection()
  const anchorNode = selection?.anchorNode ?? null
  const anchorElement = anchorNode instanceof Element
    ? anchorNode
    : anchorNode?.parentElement ?? null

  if (anchorElement instanceof HTMLElement && anchorElement.isContentEditable) {
    return anchorElement
  }
  return anchorElement?.closest('[contenteditable=""], [contenteditable="true"]') ?? null
}

function insertIntoContentEditable(
  element: HTMLElement,
  text: string,
  source: InsertionSource,
): TextInsertionResult {
  const selection = window.getSelection()
  const range = selection && selection.rangeCount > 0
    ? selection.getRangeAt(0).cloneRange()
    : document.createRange()

  if (!selection || selection.rangeCount === 0 || !element.contains(range.commonAncestorContainer)) {
    range.selectNodeContents(element)
    range.collapse(false)
  }

  range.deleteContents()
  const node = document.createTextNode(text)
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection?.removeAllRanges()
  selection?.addRange(range)

  dispatchTextInputEvent(element, text)

  return buildResult({
    ok: true,
    strategy: 'renderer_dom',
    detail: `source=${source} ${describeElement(element)}`,
  }, {
    strategy: 'renderer_dom',
    ok: true,
    detail: `source=${source} ${describeElement(element)}`,
  })
}

function resolveInsertionTarget(element: Element | null): HTMLElement | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element
  }
  return findContentEditableTarget(element)
}

function storeCapturedTarget(target: HTMLElement) {
  capturedTarget = target
  capturedTargetDetail = describeElement(target)
}

function clearDisconnectedCapturedTarget() {
  if (capturedTarget && !capturedTarget.isConnected) {
    capturedTarget = null
    capturedTargetDetail = ''
  }
}

function buildCaptureFailure(
  reason: 'no_active_element' | 'unsupported_active_element',
  detail: string,
  options?: CaptureOptions,
): TextInsertionAttempt {
  clearDisconnectedCapturedTarget()
  if (!options?.preserveExistingOnFailure) {
    clearCapturedInsertionTarget()
    return {
      strategy: 'renderer_dom',
      ok: false,
      reason,
      detail,
    }
  }

  return {
    strategy: 'renderer_dom',
    ok: false,
    reason,
    detail: capturedTargetDetail ? `${detail} preserved=${capturedTargetDetail}` : detail,
  }
}

function captureResolvedTarget(
  preferredElement?: Element | null,
  options?: CaptureOptions,
): TextInsertionAttempt {
  const active = preferredElement ?? getDeepActiveElement()
  if (!active) {
    return buildCaptureFailure(
      'no_active_element',
      'capture source=active element=null',
      options,
    )
  }

  const target = resolveInsertionTarget(active)
  if (!target) {
    return buildCaptureFailure(
      'unsupported_active_element',
      `capture source=active ${describeElement(active)}`,
      options,
    )
  }

  storeCapturedTarget(target)
  return {
    strategy: 'renderer_dom',
    ok: true,
    detail: `capture source=active ${capturedTargetDetail}`,
  }
}

export function startInsertionTargetTracking() {
  if (targetTrackingStarted || typeof document === 'undefined') return
  targetTrackingStarted = true

  const onFocusIn = (event: FocusEvent) => {
    const nextTarget = event.target instanceof Element ? event.target : getDeepActiveElement()
    captureResolvedTarget(nextTarget, { preserveExistingOnFailure: true })
  }

  const onSelectionChange = () => {
    const active = getDeepActiveElement()
    if (!active) return
    const target = resolveInsertionTarget(active)
    if (target) {
      storeCapturedTarget(target)
    }
  }

  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('selectionchange', onSelectionChange)

  removeTargetTrackingListeners = [
    () => document.removeEventListener('focusin', onFocusIn, true),
    () => document.removeEventListener('selectionchange', onSelectionChange),
  ]

  captureResolvedTarget(undefined, { preserveExistingOnFailure: true })
}

export function stopInsertionTargetTracking() {
  if (!targetTrackingStarted) return
  targetTrackingStarted = false
  for (const remove of removeTargetTrackingListeners) {
    remove()
  }
  removeTargetTrackingListeners = []
}

export function captureActiveInsertionTarget(
  preferredElement?: Element | null,
  options?: CaptureOptions,
): TextInsertionAttempt {
  return captureResolvedTarget(preferredElement, options)
}

export function clearCapturedInsertionTarget() {
  capturedTarget = null
  capturedTargetDetail = ''
}

function insertTextIntoElement(
  element: HTMLElement,
  text: string,
  source: InsertionSource,
): TextInsertionResult {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return insertIntoTextControl(element, text, source)
  }

  if (element.isContentEditable) {
    return insertIntoContentEditable(element, text, source)
  }

  return buildResult({
    ok: false,
    strategy: 'renderer_dom',
    reason: 'unsupported_active_element',
    detail: `source=${source} ${describeElement(element)}`,
  }, {
    strategy: 'renderer_dom',
    ok: false,
    reason: 'unsupported_active_element',
    detail: `source=${source} ${describeElement(element)}`,
  })
}

export function insertTextIntoActiveElement(text: string): TextInsertionResult {
  const active = getDeepActiveElement()

  if (!active) {
    return buildResult({
      ok: false,
      strategy: 'renderer_dom',
      reason: 'no_active_element',
      detail: 'source=active element=null',
    }, {
      strategy: 'renderer_dom',
      ok: false,
      reason: 'no_active_element',
      detail: 'source=active element=null',
    })
  }

  const target = resolveInsertionTarget(active)
  if (target) {
    return insertTextIntoElement(target, text, 'active')
  }

  return buildResult({
    ok: false,
    strategy: 'renderer_dom',
    reason: 'unsupported_active_element',
    detail: `source=active ${describeElement(active)}`,
  }, {
    strategy: 'renderer_dom',
    ok: false,
    reason: 'unsupported_active_element',
    detail: `source=active ${describeElement(active)}`,
  })
}

export function insertTextIntoCapturedOrActiveElement(text: string): TextInsertionResult {
  clearDisconnectedCapturedTarget()

  if (capturedTarget) {
    return insertTextIntoElement(capturedTarget, text, 'captured')
  }

  return withDetailPrefix(insertTextIntoActiveElement(text), 'capture=no_captured_target')
}
