import { invoke } from '@tauri-apps/api/core'
import { addRuntimeEvent } from '../debugLog'
import type { OverlayService } from './OverlayService'
import type { RecorderState } from './types'
import {
  classifyMicLevel,
  hasSilenceEvidence,
  judgeOsMicMute,
  type MicLevel,
} from './helpers'

const MIC_MUTED_AUTO_CANCEL_MS = 3000
const SILENCE_RMS_THRESHOLD = 0.01

/** MicLevelMonitor 要从编排器拿的东西：只读的录音状态，加一个「静音超时就取消」的动作。 */
export interface MicLevelHost {
  overlay: OverlayService
  isRunCurrent(runId: number): boolean
  getState(): RecorderState
  /** startRecording 还在初始化（state 仍是 idle）。 */
  isStarting(): boolean
  getActiveRunId(): number
  getSelectedMicId(): string
  cancelForMutedMic(runId: number): void
  /** 本次录音打开的是虚拟设备时返回 true（用于把「未检测到声音」说得更具体）。拿不准返回 false。 */
  isActiveMicVirtual?(): boolean
  /** 本次录音第一次确认听到正常人声时调用一次。 */
  onVoiceDetected?(): void
}

/**
 * 录音时的麦克风电平：音量两档提醒、系统静音标志的裁决、本次录音的音频统计。
 * 从 RecorderOrchestrator 拆出（模块 6），行为不变。
 */
export class MicLevelMonitor {
  /** 系统确认麦克风静音后的自动取消计时器，避免悬浮窗无限停留。 */
  private micMutedAutoCancelId: ReturnType<typeof setTimeout> | null = null
  /** 静音探测代次：实际打开设备的复核必须覆盖较早发起的预检查结果。 */
  private micMuteProbeSequence = 0
  /** 连续「非正常音量」（静音或偏低）的采样数 */
  private consecutiveSilentSamples = 0
  /** 当前连续非正常音量的采样数，仅用于判断正常说话候选之间的间隔。 */
  private consecutiveNonVoicedSamples = 0
  /** 当前这段安静里是否出现过任何非零采样。
   * 只要为真，就只能提示「请靠近麦克风」，不能提示「未检测到声音」。 */
  private quietRunSawSignal = false
  /** 连续正常音量的采样数——用于「持续说话一段时间才清除警告」的迟滞判断，避免瞬时小声音把警告瞬间清掉造成闪烁 */
  private consecutiveVoicedSamples = 0
  /** 悬浮窗当前正在显示的音量类警告 */
  private currentVolumeWarning: 'none' | 'muted' | 'low' = 'none'
  /** 本次录音是否已经听到过一次正常音量的说话。一旦听到过，说明麦克风正常，
   *  后续安静只是正常停顿思考——只给温和「请靠近麦克风」，绝不再报「未检测到声音」造成惊吓。 */
  private hasDetectedVoiceThisSession = false
  private lastLowVolumeWarnAt = 0
  /** 麦克风被静音已被「系统标志 + 音频信号」双重证实。为真时悬浮窗显示红色高警，
   *  并抑制基于信号的琥珀提醒，直到检测到真实说话（用户中途取消了静音）。 */
  private osMicMuted = false
  /** 系统报了「端点被静音」，但还没被音频信号证实。
   *
   *  为什么不能直接相信系统：IAudioEndpointVolume::GetMute 反映的是端点上的静音**设置**，
   *  不等于采集流真被切断。实测 Plantronics Blackwire 5220 USB 耳麦（软/硬静音会与 Windows
   *  端点标志同步）会停在 GetMute=true，而 getUserMedia 照常收到正常音量的音频 —— 于是每次
   *  按热键都先弹一次红色高警「麦克风已被静音」，说话 0.5s 后又自己消失。
   *  所以这个标志只当线索：必须等 PCM 证实真的全 0 才升级成 osMicMuted。 */
  private pendingOsMicMuted = false
  /** pending 期间累计的全 0 采样数，达到 OS_MIC_MUTE_CONFIRM_SAMPLES 才确认。 */
  private pendingOsMicMutedSamples = 0

  /** Audio stats tracking */
  private statsRmsSum = 0
  private statsPeakRms = 0
  private statsPeakAmplitude = 0
  private statsSilentFrames = 0
  private statsTotalFrames = 0

  constructor(private readonly host: MicLevelHost) { }

  /** 录音一开始（显示悬浮窗之前）就清掉上一次的静音线索。与 resetLevels 分开：两次中间夹着异步的静音预检查。 */
  resetMuteState() {
    this.clearAutoCancelTimer()
    this.osMicMuted = false
    this.pendingOsMicMuted = false
    this.pendingOsMicMutedSamples = 0
  }

  /** 取完录音上下文、开始采集之前清掉统计和音量提醒。 */
  resetLevels() {
    this.statsRmsSum = 0
    this.statsPeakRms = 0
    this.statsPeakAmplitude = 0
    this.statsSilentFrames = 0
    this.statsTotalFrames = 0
    this.consecutiveSilentSamples = 0
    this.consecutiveNonVoicedSamples = 0
    this.quietRunSawSignal = false
    this.consecutiveVoicedSamples = 0
    this.currentVolumeWarning = 'none'
    this.hasDetectedVoiceThisSession = false
    this.lastLowVolumeWarnAt = 0
  }

  /**
   * 回到空闲时清提醒和静音线索，**不清音频统计**：超时宽限期里判断「有没有静音实证」
   * 还要用到这一段的统计，下一次 resetLevels 才清。
   */
  resetOnIdle() {
    this.consecutiveSilentSamples = 0
    this.consecutiveNonVoicedSamples = 0
    this.quietRunSawSignal = false
    this.consecutiveVoicedSamples = 0
    this.currentVolumeWarning = 'none'
    this.hasDetectedVoiceThisSession = false
    this.lastLowVolumeWarnAt = 0
    this.osMicMuted = false
    this.pendingOsMicMuted = false
    this.pendingOsMicMutedSamples = 0
  }

  /** 让已发出的静音查询作废（录音结束、清理时）。 */
  invalidateProbes() {
    this.micMuteProbeSequence++
  }

  nextProbeSequence(): number {
    return ++this.micMuteProbeSequence
  }

  /** 每一帧 PCM 调一次：累计统计并推进音量提醒。 */
  onFrame(pcmFrame: Int16Array) {
    // 计算本帧 RMS 与峰值幅度（均归一化到 0..1）。峰值严格为 0 才表示整帧没有输入；
    // 只要存在任何非零采样，就必须和「未检测到声音」区分开。
    let sum = 0
    let framePeakRaw = 0
    for (let i = 0; i < pcmFrame.length; i++) {
      const s = pcmFrame[i]
      sum += s * s
      const amp = s < 0 ? -s : s
      if (amp > framePeakRaw) framePeakRaw = amp
    }
    const rms = Math.sqrt(sum / pcmFrame.length) / 32768
    const framePeak = framePeakRaw / 32768

    // Audio stats tracking
    this.statsTotalFrames++
    this.statsRmsSum += rms
    if (rms > this.statsPeakRms) this.statsPeakRms = rms
    if (framePeak > this.statsPeakAmplitude) this.statsPeakAmplitude = framePeak
    if (rms < SILENCE_RMS_THRESHOLD) this.statsSilentFrames++

    // 两档提醒：静音（未检测到声音）/ 偏低（请靠近麦克风）
    this.updateVolumeWarning(classifyMicLevel(rms, framePeak), pcmFrame.length)
  }

  /** 随 stop 发给服务端、并写进日志的统计。没收到过帧时为 undefined。 */
  summary() {
    return this.statsTotalFrames > 0 ? {
      avgRms: Math.round((this.statsRmsSum / this.statsTotalFrames) * 10000) / 10000,
      peakRms: Math.round(this.statsPeakRms * 10000) / 10000,
      peakAmplitude: Math.round(this.statsPeakAmplitude * 10000) / 10000,
      silenceRatio: Math.round((this.statsSilentFrames / this.statsTotalFrames) * 1000) / 1000,
      totalFrames: this.statsTotalFrames,
    } : undefined
  }

  roundedPeakAmplitude(): number {
    return Math.round(this.statsPeakAmplitude * 10000) / 10000
  }

  /**
   * 这段录音是否有「确实没有可用语音」的实测证据。
   *
   * 为什么要证据：「未检测到有效声音」是全软件最容易被误读的一句话，它会把用户直接
   * 引去查麦克风。而同一句话背后的真实成因可能是额度耗尽、服务端提前断开、热词回显
   * 被判定清空（见 pitfalls 15）。没有证据时就该说「没有取得识别结果」，别替用户
   * 下结论。
   *
   * 判据本身抽到了 helpers.ts（纯函数，带单测钉住"两个条件必须同时成立"那一刀）。
   */
  hasSilenceEvidence(): boolean {
    return hasSilenceEvidence({
      totalFrames: this.statsTotalFrames,
      silentFrames: this.statsSilentFrames,
      peakAmplitude: this.statsPeakAmplitude,
      silenceRmsThreshold: SILENCE_RMS_THRESHOLD,
    })
  }

  private markVoiceDetected() {
    const first = !this.hasDetectedVoiceThisSession
    this.hasDetectedVoiceThisSession = true
    if (first) this.host.onVoiceDetected?.()
  }

  clearAutoCancelTimer() {
    if (this.micMutedAutoCancelId) {
      clearTimeout(this.micMutedAutoCancelId)
      this.micMutedAutoCancelId = null
    }
  }

  private scheduleMicMutedAutoCancel(runId: number) {
    this.clearAutoCancelTimer()
    const closeWhenReady = () => {
      this.micMutedAutoCancelId = null
      if (!this.host.isRunCurrent(runId) || !this.osMicMuted) return
      if (this.host.getState() === 'idle' && this.host.isStarting()) {
        // 防御：这个计时器现在只在收到音频帧后才排，理论上必定已在 recording。
        // 万一将来又从「采集就绪前」的路径调用，也不要在这里直接放弃。
        this.micMutedAutoCancelId = setTimeout(closeWhenReady, 100)
        return
      }
      if (this.host.getState() !== 'recording') return
      addRuntimeEvent('info', 'recorder', 'Muted microphone warning timed out; recording will close automatically', {
        runId,
        timeoutMs: MIC_MUTED_AUTO_CANCEL_MS,
      })
      this.host.cancelForMutedMic(runId)
    }
    this.micMutedAutoCancelId = setTimeout(closeWhenReady, MIC_MUTED_AUTO_CANCEL_MS)
  }

  /** 在采集链路初始化前查询系统静音状态；默认设备不经过可能很慢的设备枚举。 */
  async checkConfiguredMicMuted(runId: number) {
    // 在任何异步操作之前占用代次；之后发起的实际设备复核可以可靠淘汰本次预检查。
    const probeSequence = ++this.micMuteProbeSequence
    // 空值与 Web Media 的 "default" 都表示跟随 Windows 当前默认录音端点。
    // 直接把 null 交给原生层查询该端点的 GetMute；deviceId 只用于定位，不参与静音判定。
    if (!this.host.getSelectedMicId() || this.host.getSelectedMicId() === 'default') {
      await this.checkMicMuted(null, runId, probeSequence)
      return
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (probeSequence !== this.micMuteProbeSequence || !this.host.isRunCurrent(runId)) return
      const inputs = devices.filter((device) => device.kind === 'audioinput')
      const selected = inputs.find((device) => device.deviceId === this.host.getSelectedMicId())

      const label = selected?.label?.trim() || ''
      // 指定设备却无法取得名称时不能回退查系统默认端点，否则可能把另一支麦克风的状态报过来。
      if (!label) return
      await this.checkMicMuted(label, runId, probeSequence)
    } catch {
      // 预检查失败不影响录音；采集真正打开后还会用 MediaStreamTrack.label 再复核一次。
    }
  }

  /**
   * 录音时的音量提醒状态机（两档）：
   *  - muted（PCM 全 0）：麦克风没有任何输入 → 「未检测到声音」
   *  - low （有声音但 RMS 偏低）：距离远 / 说太小声 → 「请靠近麦克风」
   *  - voiced（正常）：连续约 0.5s 即认定恢复，清除提醒
   *
   * 关键准确性约束：「未检测到声音」只在「从录音开始就没听到过正常说话，且这整段安静里
   * 每个采样都为 0」时才报；任何非零输入都只能算声音小。这样也避免把说话后的正常停顿
   * 思考误判成设备故障（那种情况只温和提示「请靠近麦克风」）。
   * 计时/迟滞沿用原逻辑：没听到过说话时更早提醒（2s），
   * 听到过后放宽（5s）；同档每 5s 重弹；连续正常音量 0.5s 才清警告，避免瞬时小声闪烁。
   */
  private updateVolumeWarning(level: MicLevel, sampleCount: number) {
    const REWARN_MS = 5000
    const CLEAR_VOICED = 8000 // ~0.5s @16kHz 累计正常音量才清除
    const VOICED_GAP_TOLERANCE = 4800 // ~300ms：容忍说话中字与字之间的短暂停顿，不清零已累计的清除进度
    const firstWarn = this.hasDetectedVoiceThisSession ? 80000 : 32000 // 5s / 2s @16kHz

    // 系统报了端点静音，但那只是设置标志，不代表采集流真被切断（见 pendingOsMicMuted）。
    // 用真实 PCM 裁决：全 0 累计到阈值才升级成红色高警；一旦出现任何非零采样，
    // 就说明这块设备的 mute 标志不作数，本次录音永久丢弃这条线索。
    if (this.pendingOsMicMuted) {
      const decision = judgeOsMicMute(this.pendingOsMicMutedSamples, level, sampleCount)
      if (decision.verdict === 'confirmed') {
        this.pendingOsMicMuted = false
        this.pendingOsMicMutedSamples = 0
        this.osMicMuted = true
        addRuntimeEvent('warn', 'recorder', 'Microphone is muted by the operating system (confirmed: audio is all-zero)')
        this.host.overlay.showMicMutedAlert()
        this.scheduleMicMutedAutoCancel(this.host.getActiveRunId())
      } else if (decision.verdict === 'dismissed') {
        this.pendingOsMicMuted = false
        this.pendingOsMicMutedSamples = 0
        addRuntimeEvent('info', 'recorder', 'System reported the microphone as muted but audio is flowing; ignoring the flag')
      } else {
        this.pendingOsMicMutedSamples = decision.silentSamples
      }
    }

    // 系统已确认被静音：保持红色高警，不让琥珀提醒覆盖它；
    // 一旦收到真实说话（用户中途取消了静音）立即恢复正常。
    if (this.osMicMuted) {
      if (level === 'voiced') {
        this.consecutiveVoicedSamples += sampleCount
        this.consecutiveNonVoicedSamples = 0
        if (this.consecutiveVoicedSamples < CLEAR_VOICED) return
      } else {
        this.consecutiveNonVoicedSamples += sampleCount
        if (this.consecutiveNonVoicedSamples >= VOICED_GAP_TOLERANCE) this.consecutiveVoicedSamples = 0
        return
      }
      this.osMicMuted = false
      this.clearAutoCancelTimer()
      this.host.overlay.clearWarning()
      this.currentVolumeWarning = 'none'
      this.consecutiveVoicedSamples = 0
      this.consecutiveSilentSamples = 0
      this.consecutiveNonVoicedSamples = 0
      this.quietRunSawSignal = false
      this.markVoiceDetected()
      return
    }

    if (level === 'voiced') {
      // 即使还不足 0.5s、尚未确认恢复正常，也已经证明输入不为零。
      this.quietRunSawSignal = true
      this.consecutiveVoicedSamples += sampleCount
      this.consecutiveNonVoicedSamples = 0
      if (this.consecutiveVoicedSamples >= CLEAR_VOICED) {
        this.markVoiceDetected()
        this.consecutiveSilentSamples = 0
        this.quietRunSawSignal = false
        if (this.currentVolumeWarning !== 'none') {
          this.host.overlay.clearWarning()
          this.currentVolumeWarning = 'none'
        }
      }
      return
    }

    // 非正常音量（muted / low）：累计安静时长；任何非零输入都永久标记本段并非「无声音」。
    this.consecutiveSilentSamples += sampleCount
    this.consecutiveNonVoicedSamples += sampleCount
    if (level === 'low') this.quietRunSawSignal = true
    // 说话时字与字之间的短暂停顿（<~300ms）不清零已累计的正常音量，否则一句话里的自然
    // 停顿会反复把"清除进度"打回 0，导致明明在正常说话也凑不满连续 0.5s、警告始终清不掉。
    // 只有持续安静超过这个小间隙，才认为不是说话停顿、归零重新计。
    if (this.consecutiveNonVoicedSamples >= VOICED_GAP_TOLERANCE) this.consecutiveVoicedSamples = 0

    if (this.consecutiveSilentSamples < firstWarn) return

    // 只有从未正常说过话且整段所有采样均为 0，才允许提示「未检测到声音」。
    const kind: 'muted' | 'low' =
      !this.hasDetectedVoiceThisSession && !this.quietRunSawSignal ? 'muted' : 'low'

    const now = Date.now()
    // 切换到不同档位立即刷新文案；同档位按节流重弹，避免频繁催促
    if (kind === this.currentVolumeWarning && now - this.lastLowVolumeWarnAt < REWARN_MS) return
    this.lastLowVolumeWarnAt = now
    this.currentVolumeWarning = kind
    if (kind === 'muted') {
      const virtualMic = this.host.isActiveMicVirtual?.() === true
      addRuntimeEvent('warn', 'recorder', 'No microphone signal detected; device may be wrong or unavailable', { virtualMic })
      this.host.overlay.showNoSignalWarning({ virtualMic })
    } else {
      addRuntimeEvent('warn', 'recorder', 'Microphone volume is low')
      this.host.overlay.showLowVolumeWarning()
    }
  }

  /**
   * 录音开始时查询系统麦克风的静音标志，作为「麦克风已被静音」红色高警的**线索**记录下来；
   * 真正弹警告要等音频帧证实 PCM 全 0（见 pendingOsMicMuted）——系统标志会骗人。
   * 仅在能可靠定位设备时才采信（系统默认设备，或按名字唯一匹配到选中设备），
   * 否则（如选了特定设备但拿不到名字/同名多个）返回不判定，交给基于信号的琥珀提醒兜底。
   */
  async checkMicMuted(
    activeDeviceLabel: string | null,
    runId: number,
    probeSequence: number,
  ) {
    try {
      // 查询本次 getUserMedia 实际打开的端点，而不是根据设置值或 deviceId 猜测。
      // 设备名无法唯一匹配时 Rust 返回 matched=false，继续交给信号检测兜底。
      const res = await invoke<{ matched: boolean; muted: boolean }>('get_mic_mute_state', {
        deviceLabel: activeDeviceLabel,
      })
      // 后发的实际设备复核优先；旧探测、旧录音或已恢复正常说话时都不能再弹。
      if (probeSequence !== this.micMuteProbeSequence || !this.host.isRunCurrent(runId)) return
      if (this.host.getState() !== 'recording' && !(this.host.getState() === 'idle' && this.host.isStarting())) return
      if (this.hasDetectedVoiceThisSession || !res.matched) return

      if (res.muted) {
        // 只记线索、不弹 UI：等音频帧证实真的全 0（原因见 pendingOsMicMuted 注释）。
        // 已确认、或已在等待证实时都不要重置累计进度（预检查与实际设备复核都会走到这里）。
        if (this.osMicMuted || this.pendingOsMicMuted) return
        this.pendingOsMicMuted = true
        this.pendingOsMicMutedSamples = 0
        addRuntimeEvent('info', 'recorder', 'System reports the microphone endpoint is muted; waiting for audio to confirm')
      } else {
        // 实际打开的端点与预检查不一致，或用户在初始化期间取消了静音。
        this.pendingOsMicMuted = false
        this.pendingOsMicMutedSamples = 0
        if (this.osMicMuted) {
          this.osMicMuted = false
          this.clearAutoCancelTimer()
          this.host.overlay.clearWarning()
        }
      }
    } catch { /* 查询失败不影响录音，交给信号检测兜底 */ }
  }
}
