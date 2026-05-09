export interface LLMMessage {
  role?: string
  content?: string
}

export interface FinalPayload {
  asr_text?: string
  llm_text?: string
  asr_ms?: number
  llm_ms?: number
  duration_sec?: number
  llm_debug?: {
    provider?: string
    messages?: LLMMessage[]
    raw_output?: string
  }
  asr_debug?: {
    duration_sec?: number
  }
}

export interface ASRPayload {
  text?: string
  asr_ms?: number
  duration_sec?: number
}

export interface ReadyPayload {
  connection_id?: string
  asr?: boolean
  llm?: boolean
}

export interface StartPayload {
  system_prompt?: string
}

export type PTTEventKind = 'down' | 'up' | 'toggle' | 'hands_free'

export interface PTTTimelineEvent {
  time: number
  kind: PTTEventKind
  source: string
  reason: string
  keycode?: number
  pttSetting?: string
  recorderState?: string
  modifiers?: {
    alt?: boolean
    ctrl?: boolean
    shift?: boolean
  }
}

export interface PTTHoldPair {
  down: PTTTimelineEvent
  up?: PTTTimelineEvent
  holdMs?: number
}
