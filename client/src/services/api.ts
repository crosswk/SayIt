// HTTP API service for SayIt backend

import { getBackendBaseUrl } from './runtimeConfig'

async function fetchAPI<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${getBackendBaseUrl()}${path}`, options)
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json()
}

export async function getHotwords(): Promise<string[]> {
  return fetchAPI<string[]>('/api/hotwords')
}

export async function putHotwords(words: string[]): Promise<string[]> {
  return fetchAPI<string[]>('/api/hotwords', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(words),
  })
}

export async function healthCheck(): Promise<{ status: string; asr: boolean; llm: boolean }> {
  return fetchAPI('/healthz')
}

export async function healthCheckDetails(): Promise<{
  status: string
  asr: boolean
  llm: boolean
  asr_engine?: string
  asr_model?: string
}> {
  return fetchAPI('/healthz/details')
}

export interface Recording {
  name: string
  size: number
  duration_sec: number
}

export async function getRecordings(): Promise<Recording[]> {
  return fetchAPI<Recording[]>('/api/recordings')
}
