/**
 * 集中式默认配置
 *
 * 所有 getSetting() 的默认值统一在此定义。
 * 修改默认值只需改这一个文件，无需全局搜索替换。
 *
 * Prompt 相关配置（内容较长，单独存放）：
 *   - 内置润色模式 → src/services/store.ts 的 BUILTIN_PRESETS
 *   - 应用 Prompt 规则 → src/services/personalization/defaults.ts 的 BUILTIN_APP_RULES
 */

export const DEFAULTS: Record<string, unknown> = {

  // ── 工作模式 ──
  workMode: 'server', // 可选: 'server' | 'cloud_api' | 'local'

  // ── 快捷键 ──
  shortcutPTT: 'ShiftRight', // 按住说话。可选: 'AltLeft' | 'AltRight' | 'ControlLeft' | 'ControlRight' | 'ShiftLeft' | 'ShiftRight' | 'Space' | 'CapsLock' 等单键
  shortcutHandsFree: 'AltRight', // 免提模式。默认右 Alt 单键。也支持组合键格式如 'Control+Shift+S'

  // ── 麦克风 ──
  selectedMic: '', // 设备 ID，空字符串 = 系统默认

  // ── AI 校对 ──
  aiEnabled: false, // 是否开启 AI 校对。可选: true | false
  aiPromptAppend: '', // 全局附加 prompt

  // ── AI 供应商 ──
  'cloudAi.provider': 'deepseek', // 可选: 'deepseek' | 'openai_compat' | 'doubao' | 'qwen' | 'ollama'
  'cloudAi.apiUrl': '',
  'cloudAi.apiKey': '',
  'cloudAi.model': '',

  // ── ASR（云 API）──
  'cloudAsr.provider': 'doubao_v2', // 可选: 'doubao_v2' | 'qwen_realtime' | 'qwen_omni' | 'qwen_omni_turbo'
  'cloudAsr.apiKey': '',
  'cloudAsr.appId': '', // 豆包需要
  'cloudAsr.omniSystemPrompt': '', // 千问 Omni 模式的 system prompt

  // ── ASR（本地）──
  'localAsr.modelId': 'sensevoice-small', // 可选: 'sensevoice-small' | 'paraformer-zh' | 'whisper-tiny'
  'localAsr.language': 'auto', // 可选: 'auto' | 'zh' | 'en' | 'ja' | 'ko'
  'localAsr.downloadSource': 'modelscope', // 可选: 'modelscope' | 'huggingface'
  'localAsr.model': '',

  // ── 服务器 ──
  'server.language': 'auto', // 可选: 'auto' | 'Chinese' | 'English' | 'Cantonese'

  // ── 悬浮窗 ──
  overlayWaveTheme: 'black-rainbow', // 可选: 'black-rainbow' | 'black-blue' | 'black-white'
  overlayShowDuration: true, // 是否显示录音时长。可选: true | false
  overlayWidth: 'short', // 可选: 'short' | 'medium' | 'long'

  // ── 提示音 ──
  readySoundEnabled: true, // 录音就绪提示音。可选: true | false

  // ── 应用设置 ──
  autoCheckUpdate: true, // 自动检查更新。可选: true | false
  audioRetentionEnabled: true, // 保留录音文件。可选: true | false
  audioRetentionDays: -1, // 录音保留天数。可选: 7 | 30 | 90 | -1（永久）
  logRetentionDays: 30, // 日志保留天数。可选: 7 | 15 | 30 | 90

  // ── 热词 ──
  hotwordLearning: null,

  // ── 引导 ──
  onboardingVersion: '', // 已完成引导的版本号，空字符串 = 未完成
}

/**
 * 获取指定 key 的默认值。
 * 如果 key 不在 DEFAULTS 中，返回提供的 fallback。
 */
export function getDefault<T>(key: string, fallback?: T): T {
  if (key in DEFAULTS) {
    return DEFAULTS[key] as T
  }
  return fallback as T
}
