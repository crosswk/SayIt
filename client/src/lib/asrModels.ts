/**
 * ASR 供应商 key → 实际模型 ID 映射
 */

const QWEN_OMNI_MODEL_MAP: Record<string, string> = {
  qwen_omni_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_flash: 'qwen3.5-omni-flash-realtime',
  qwen_omni_flash: 'qwen3-omni-flash-realtime',
  qwen_omni_turbo: 'qwen-omni-turbo-realtime',
}

/** 判断是否为 Qwen Omni 系列模型 */
export function isQwenOmniProvider(provider: string): boolean {
  return provider.startsWith('qwen_omni')
}

/** 根据供应商 key 解析 Qwen Omni 模型 ID，非 Omni 返回 undefined */
export function resolveQwenOmniModel(provider: string): string | undefined {
  return QWEN_OMNI_MODEL_MAP[provider]
}

/** ASR 供应商 key → 显示用的模型 ID */
const ASR_DISPLAY_MODEL_MAP: Record<string, string> = {
  doubao_v2: 'Doubao-Seed-ASR-2.0',
  qwen: 'qwen3-asr-flash',
  ...QWEN_OMNI_MODEL_MAP,
}

/** 将内部供应商 key 映射为显示用的模型名称 */
export function resolveAsrDisplayModel(providerKey: string): string {
  return ASR_DISPLAY_MODEL_MAP[providerKey] || providerKey || 'unknown'
}
