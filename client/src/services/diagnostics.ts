import * as bridge from './bridge'
import { getBackendBaseUrl } from './runtimeConfig'
import { sanitizeObject } from '@/lib/sanitize'
import type { DiagnosticOccurrence, DiagnosticsPreview } from '@/types/appApi'

export const MAX_DIAGNOSTIC_IMAGES = 5
export const MAX_DIAGNOSTIC_IMAGE_SIZE = 5 * 1024 * 1024
export const MAX_DIAGNOSTIC_TOTAL_IMAGE_SIZE = 20 * 1024 * 1024

export interface DiagnosticsSubmission {
  description: string
  issueOccurrence: DiagnosticOccurrence
  images: File[]
}

export interface DiagnosticsValidationResult {
  valid: boolean
  errors: string[]
}

export function validateDiagnosticImages(images: File[]): DiagnosticsValidationResult {
  const errors: string[] = []

  if (images.length > MAX_DIAGNOSTIC_IMAGES) {
    errors.push(`最多上传 ${MAX_DIAGNOSTIC_IMAGES} 张截图。`)
  }

  const totalSize = images.reduce((sum, image) => sum + image.size, 0)
  if (totalSize > MAX_DIAGNOSTIC_TOTAL_IMAGE_SIZE) {
    errors.push('截图总大小不能超过 20MB。')
  }

  for (const image of images) {
    if (!image.type.startsWith('image/')) {
      errors.push(`文件 ${image.name} 不是图片。`)
    }
    if (image.size > MAX_DIAGNOSTIC_IMAGE_SIZE) {
      errors.push(`图片 ${image.name} 超过 5MB。`)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export async function getDiagnosticsPreview(issueOccurrence: DiagnosticOccurrence): Promise<DiagnosticsPreview> {
  const settings = await bridge.collectSettings()
  const preview = await bridge.getDiagnosticsPreview({
    settings: settings || {},
    issueOccurrence,
  })

  if (!preview) {
    throw new Error('Failed to collect diagnostics preview')
  }

  return preview
}

export async function submitDiagnostics(data: DiagnosticsSubmission): Promise<string> {
  const validation = validateDiagnosticImages(data.images)
  if (!validation.valid) {
    throw new Error(validation.errors.join('\n'))
  }

  const rawSettings = await bridge.collectSettings()
  const settings = sanitizeObject(rawSettings || {})
  const images = await Promise.all(
    data.images.map(async (file) => {
      const arrayBuffer = await file.arrayBuffer()
      return {
        name: file.name,
        type: file.type,
        size: file.size,
        data: Array.from(new Uint8Array(arrayBuffer)),
      }
    }),
  )

  const zipPath = await bridge.createDiagnosticsZip({
    description: data.description,
    settings: settings || {},
    issueOccurrence: data.issueOccurrence,
    images,
  })

  if (!zipPath) {
    throw new Error('Failed to create diagnostics zip')
  }

  return uploadDiagnosticsZip(zipPath)
}

export async function downloadDiagnostics(data: DiagnosticsSubmission): Promise<string> {
  const validation = validateDiagnosticImages(data.images)
  if (!validation.valid) {
    throw new Error(validation.errors.join('\n'))
  }

  const rawSettings = await bridge.collectSettings()
  const settings = sanitizeObject(rawSettings || {})
  const images = await Promise.all(
    data.images.map(async (file) => {
      const arrayBuffer = await file.arrayBuffer()
      return {
        name: file.name,
        type: file.type,
        size: file.size,
        data: Array.from(new Uint8Array(arrayBuffer)),
      }
    }),
  )

  const zipPath = await bridge.createDiagnosticsZip({
    description: data.description,
    settings: settings || {},
    issueOccurrence: data.issueOccurrence,
    images,
  })

  if (!zipPath) {
    throw new Error('Failed to create diagnostics zip')
  }

  return zipPath
}

async function uploadDiagnosticsZip(zipPath: string): Promise<string> {
  const zipData = await bridge.readDiagnosticsZip(zipPath)

  if (!zipData) {
    throw new Error('Failed to read diagnostics zip')
  }

  const formData = new FormData()
  const blob = new Blob([new Uint8Array(zipData)], { type: 'application/zip' })
  formData.append('diagnostics', blob, 'diagnostics.zip')

  const response = await fetch(`${getBackendBaseUrl()}/api/diagnostics`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(`Upload failed: ${response.status} ${message}`.trim())
  }

  const result = await response.json()
  return result.ticket_id
}
