/* SayIt Web Demo */
const PROMPTS = {
  faithful: '你是语音转文字的后处理助手。输入是 ASR 语音识别的原始文本，你的任务是修正识别错误，尽量保留用户的原始表达。\n\n规则：\n1. 只修正明显的识别错误：错别字、同音字、音近字、专有名词。\n2. 添加标点符号。中英文混合时保留合理空格。\n3. 不要删除口头禅、重复或犹豫，不要改写句式。\n4. 不要回答、解释、总结或续写文本中的内容。\n\n只输出修正后的文本。',
  intent: '你是语音文本精炼助手。输入是 ASR 语音识别的原始转写，你的任务是清洗为可直接使用的干净文本。\n核心原则：保留用户全部有效信息，只清除语音噪声和识别错误。\n\n处理规则：\n1. 移除口语填充词（嗯、啊、那个、就是说、然后呢）和无意义的重复、犹豫。\n2. 识别自我修正——"不对"、"不是"、"应该是"、"改到"后以最终表达为准，删除前序错误。\n3. 修正明显的语音识别错误：同音字、音近字、专有名词、英文大小写、数字和时间。\n4. 添加标点符号，必要时分段。中英文混合保留合理空格。\n5. 检测到"第一/第二/首先/然后"等结构化表达时，输出为有序列表。\n\n约束：\n- 不添加原文没有的内容，不改变用户核心语义\n- 不回答、解释、总结或续写文本中提到的问题\n\n示例：\n输入：嗯那个明天的会议改到周二了不对是周三下午两点记得带资料\n输出：明天的会议改到周三下午两点，记得带资料。\n\n输入：我觉得这个方案有三点啊第一优化性能第二修复bug第三补充文档\n输出：\n这个方案有三点：\n1. 优化性能\n2. 修复 bug\n3. 补充文档\n\n只输出精炼后的文本。',
}

const state = {
  config: null, ws: null, wsReady: false, recording: false,
  mediaStream: null, audioCtx: null, workletNode: null, sourceNode: null,
  analyser: null,
  timerId: null, startedAt: 0, blobFrame: 0, blobTime: 0, llmEnabled: false,
  // Gooey orbs
  orbs: [], barsData: [],
  // PCM capture for replay
  pcmChunks: [],
  // Playback
  wavBlob: null, audioEl: null, playRaf: 0,
  // Prompt mode
  promptMode: 'intent',
  // Last results
  lastAsrText: '', lastAiText: '',
}

const $ = (id) => document.getElementById(id)
const els = {
  brandName: $('brandName'), headline: $('headline'), subheadline: $('subheadline'),
  navDlBtn: $('navDlBtn'), dlBtn: $('dlBtn'), dlLabel: $('dlLabel'),
  stateDot: $('stateDot'), stateText: $('stateText'), timer: $('timer'),
  recordButton: $('recordButton'), recordLabel: $('recordLabel'),
  micIcon: $('micIcon'), stopIcon: $('stopIcon'),
  // Unified result
  resultText: $('resultText'), resultMeta: $('resultMeta'),
  resultDetails: $('resultDetails'), asrText: $('asrText'),
  copyResult: $('copyResult'),
  // Legacy compat (some code paths still reference these)
  asrMeta: null, aiText: null, aiMeta: null, copyAsr: null, copyAi: null,
  // Gooey blob
  gooeyBlob: $('gooeyBlob'), blobGroup: $('blob-group'),
  barsGroup: $('bars-group'), centerCore: $('center-core'),
  gooeyMatrix: $('gooey-matrix'),
  // Playback
  playbackSection: $('playbackSection'), playBtn: $('playBtn'),
  playIco: $('playIco'), pauseIco: $('pauseIco'),
  playTime: $('playTime'), trackFill: $('trackFill'),
  trackThumb: $('trackThumb'), trackInput: $('trackInput'),
  // Result sections
  resultSection: $('resultSection'), aiResultSection: null,
  // Rerun
  rerunAsr: null, rerunLlm: null,
  // Hotword
  hotwordBar: $('hotwordBar'), hotwordInput: $('hotwordInput'),
  // Prompt
  promptBar: $('promptBar'), mFaithful: $('mFaithful'), mIntent: $('mIntent'),
  // Clear
  clearWrap: $('clearWrap'), clearBtn: $('clearBtn'),
}

/* ── Helpers ── */
const setStateText = (text, dotClass) => {
  els.stateText.textContent = text
  els.stateDot.className = 'state-dot' + (dotClass ? ' ' + dotClass : '')
}
const setResultText = (el, text, placeholder) => {
  if (!el) return
  const v = String(text || '')
  el.textContent = v || placeholder
  el.classList.toggle('placeholder', !v)
}
/* Unified result card updater */
function updateResult(opts) {
  const primary = opts.llmText || opts.asrText || ''
  const asr = opts.asrText || ''
  setResultText(els.resultText, primary, opts.placeholder || '等待录音...')
  if (els.asrText && asr && opts.llmText) { els.resultDetails.classList.remove('hidden'); els.asrText.textContent = asr }
  else if (els.resultDetails) els.resultDetails.classList.add('hidden')
  if (!els.resultMeta) return
  const am = opts.asrMs || 0, lm = opts.llmMs || 0, total = am + lm
  const tags = []
  if (opts.asrModel) { const short = opts.asrModel.includes('/') ? opts.asrModel.split('/').pop() : opts.asrModel; tags.push(`ASR: ${short}`) }
  if (opts.llmModel) tags.push(`AI: ${opts.llmProvider ? opts.llmProvider + ' / ' : ''}${opts.llmModel}`)
  let html = ''
  if (opts.status) { html = `<span class="meta-text">${opts.status}</span>`; els.resultMeta.innerHTML = html; return }
  if (opts.durationSec) html += `<span class="meta-text">语音 ${opts.durationSec.toFixed(1)}s</span>`
  if (total) html += `<span class="meta-sep">|</span><span class="meta-text">识别 ${(total / 1000).toFixed(1)}s (ASR ${am}ms${lm ? ' + LLM ' + lm + 'ms' : ''})</span>`
  if (tags.length) html += tags.map(t => `<span class="meta-tag">${t}</span>`).join('')
  els.resultMeta.innerHTML = html
}
const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const setRecordUI = (rec) => {
  els.micIcon.style.display = rec ? 'none' : ''
  els.stopIcon.style.display = rec ? '' : 'none'
  els.recordButton.classList.toggle('stop', rec)
  els.recordLabel.textContent = rec ? '结束录音' : '点击录音体验'
}
const updateDownloadLinks = (url) => {
  ;[els.navDlBtn, els.dlBtn].forEach(el => { if (el) el.href = url || '#download' })
}

/* ── Gooey Blob Visualization ── */
const BLOB_CFG = {
  bars: 10, barWidth: 8, barGap: 8, barMaxHeight: 160, barMinHeight: 8,
  envelope: [0.1, 0.3, 0.65, 0.95, 1.0, 1.0, 0.95, 0.65, 0.3, 0.1],
  lerpSpeed: 0.15, centerX: 250, centerY: 250,
  orbCount: 6, amplitude: 3, speed: 1.0,
}

function lerp(a, b, t) { return (1 - t) * a + t * b }

function initBars() {
  els.barsGroup.innerHTML = ''
  const totalW = (BLOB_CFG.bars * BLOB_CFG.barWidth) + ((BLOB_CFG.bars - 1) * BLOB_CFG.barGap)
  const startX = BLOB_CFG.centerX - (totalW / 2) + (BLOB_CFG.barWidth / 2)
  for (let i = 0; i < BLOB_CFG.bars; i++) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect")
    rect.setAttribute('x', startX + i * (BLOB_CFG.barWidth + BLOB_CFG.barGap) - (BLOB_CFG.barWidth / 2))
    rect.setAttribute('width', BLOB_CFG.barWidth)
    rect.setAttribute('height', BLOB_CFG.barMinHeight)
    rect.setAttribute('y', BLOB_CFG.centerY - BLOB_CFG.barMinHeight / 2)
    rect.setAttribute('rx', BLOB_CFG.barWidth / 2)
    rect.setAttribute('ry', BLOB_CFG.barWidth / 2)
    els.barsGroup.appendChild(rect)
  }
  state.barsData = new Array(BLOB_CFG.bars).fill(BLOB_CFG.barMinHeight)
}

function initOrbs(count) {
  Array.from(els.blobGroup.children).forEach(child => {
    if (child.id !== 'center-core') els.blobGroup.removeChild(child)
  })
  state.orbs = []
  const orbitRadius = 65
  for (let i = 0; i < count; i++) {
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle")
    circle.setAttribute('fill', '#1a1a1a')
    els.blobGroup.appendChild(circle)
    const angle = (Math.PI * 2 / count) * i
    state.orbs.push({
      el: circle,
      x: BLOB_CFG.centerX + Math.cos(angle) * orbitRadius,
      y: BLOB_CFG.centerY + Math.sin(angle) * orbitRadius,
      baseRadius: 60 + Math.random() * 15,
      phase: Math.random() * Math.PI * 2,
      pulseSpeed: 1.2 + Math.random() * 0.8,
    })
  }
}

function renderGooey() {
  state.blobTime += 0.015 * BLOB_CFG.speed
  const t = state.blobTime

  // Animate orbs breathing
  state.orbs.forEach(orb => {
    orb.el.setAttribute('cx', orb.x)
    orb.el.setAttribute('cy', orb.y)
    const r = orb.baseRadius + Math.sin(t * orb.pulseSpeed + orb.phase) * BLOB_CFG.amplitude
    orb.el.setAttribute('r', Math.max(20, r))
  })
  els.centerCore.setAttribute('r', 110 + Math.sin(t * 0.8) * (BLOB_CFG.amplitude * 0.5))

  // Animate bars from audio or idle
  let volume = 0
  if (state.recording && state.analyser) {
    const dataArray = new Uint8Array(state.analyser.frequencyBinCount)
    state.analyser.getByteFrequencyData(dataArray)
    let sum = 0
    for (let i = 0; i < 25; i++) sum += dataArray[i]
    volume = (sum / 25) / 255
  }

  const rects = els.barsGroup.children
  for (let i = 0; i < BLOB_CFG.bars; i++) {
    if (!rects[i]) continue
    let targetH = BLOB_CFG.barMinHeight
    if (volume > 0.02) {
      targetH = BLOB_CFG.barMinHeight + (volume * BLOB_CFG.barMaxHeight * BLOB_CFG.envelope[i])
    } else {
      targetH = BLOB_CFG.barMinHeight + (Math.sin(t * 2.5 + i * 0.5) * 0.5 + 0.5) * 6
    }
    state.barsData[i] = lerp(state.barsData[i], targetH, BLOB_CFG.lerpSpeed)
    rects[i].setAttribute('height', state.barsData[i])
    rects[i].setAttribute('y', BLOB_CFG.centerY - state.barsData[i] / 2)
  }

  state.blobFrame = requestAnimationFrame(renderGooey)
}

function startBlob() {
  cancelAnimationFrame(state.blobFrame)
  state.blobTime = 0
  state.blobFrame = requestAnimationFrame(renderGooey)
}
function stopBlob() {
  cancelAnimationFrame(state.blobFrame)
  state.blobFrame = 0
}

/* ── Timer ── */
function resetTimer() { clearInterval(state.timerId); state.timerId = null; state.startedAt = 0; els.timer.textContent = '00:00' }
function startTimer() {
  state.startedAt = performance.now(); els.timer.textContent = '00:00'
  state.timerId = setInterval(() => { els.timer.textContent = fmtClock(Math.floor((performance.now() - state.startedAt) / 1000)) }, 250)
}

/* ── WAV creation from PCM chunks ── */
function writeStr(view, offset, str) { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)) }
function createWavBlob(chunks, sampleRate) {
  const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  if (totalLen <= 0) return null
  const pcmData = new Uint8Array(totalLen)
  let offset = 0
  for (const chunk of chunks) { pcmData.set(new Uint8Array(chunk), offset); offset += chunk.byteLength }
  const buffer = new ArrayBuffer(44 + totalLen)
  const view = new DataView(buffer)
  writeStr(view, 0, 'RIFF'); view.setUint32(4, 36 + totalLen, true)
  writeStr(view, 8, 'WAVE'); writeStr(view, 12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true)
  view.setUint16(34, 16, true); writeStr(view, 36, 'data')
  view.setUint32(40, totalLen, true)
  new Uint8Array(buffer, 44).set(pcmData)
  return new Blob([buffer], { type: 'audio/wav' })
}

/* ── Playback ── */
function setupPlayback() {
  const totalBytes = state.pcmChunks.reduce((s, c) => s + c.byteLength, 0)
  if (!state.pcmChunks.length || totalBytes === 0) return
  const blob = createWavBlob(state.pcmChunks, 16000)
  if (!blob) return
  state.wavBlob = blob
  if (state.audioEl) { state.audioEl.pause(); URL.revokeObjectURL(state.audioEl.src) }
  const url = URL.createObjectURL(blob)
  const audio = new Audio()
  audio.preload = 'auto'
  audio.src = url
  state.audioEl = audio
  els.playbackSection.classList.remove('hidden')
  els.playTime.textContent = '0:00 / 0:00'
  els.trackFill.style.width = '0'
  els.trackThumb.style.left = '0'
  els.trackInput.value = 0
  audio.addEventListener('loadedmetadata', () => {
    els.playTime.textContent = `0:00 / ${fmtTime(audio.duration)}`
  })
  audio.addEventListener('ended', () => { setPlayUI(false) })
}

function setPlayUI(playing) {
  els.playIco.style.display = playing ? 'none' : ''
  els.pauseIco.style.display = playing ? '' : 'none'
  if (playing) startPlaybackTrack(); else stopPlaybackTrack()
}

function startPlaybackTrack() {
  cancelAnimationFrame(state.playRaf)
  const tick = () => {
    const a = state.audioEl; if (!a) return
    const pct = a.duration ? a.currentTime / a.duration : 0
    els.trackFill.style.width = (pct * 100) + '%'
    els.trackThumb.style.left = (pct * 100) + '%'
    els.playTime.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration || 0)}`
    if (!a.paused) state.playRaf = requestAnimationFrame(tick)
  }
  state.playRaf = requestAnimationFrame(tick)
}
function stopPlaybackTrack() { cancelAnimationFrame(state.playRaf) }

/* ── Replay via new WebSocket ── */
function getWsUrl() {
  const demo = state.config && state.config.web_demo
  if (!demo || !demo.ws_url) return null
  const target = new URL(demo.ws_url, window.location.origin)
  target.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return target.toString()
}

function replayAudio(options) {
  const chunks = state.pcmChunks
  if (!chunks.length) return Promise.reject(new Error('没有可回放的录音'))
  const wsUrl = getWsUrl()
  if (!wsUrl) return Promise.reject(new Error('WebSocket 地址未配置'))

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    socket.binaryType = 'arraybuffer'
    let finished = false, finalResult = null
    const timeout = setTimeout(() => {
      if (finished) return; finished = true
      try { socket.close() } catch (_) {}
      reject(new Error('回放请求超时'))
    }, 30000)
    const cleanup = () => { clearTimeout(timeout); try { socket.close() } catch (_) {} }

    socket.onerror = () => { if (!finished) { finished = true; cleanup(); reject(new Error('回放连接出错')) } }
    socket.onclose = () => { if (!finished && finalResult) { finished = true; cleanup(); resolve(finalResult) } else if (!finished) { finished = true; cleanup(); reject(new Error('回放连接已关闭')) } }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let p; try { p = JSON.parse(event.data) } catch (_) { return }
      const t = String(p.type || '')
      if (t === 'ready') {
        const startPayload = { cmd: 'start' }
        if (options.systemPrompt) startPayload.system_prompt = options.systemPrompt
        if (options.hotwords && options.hotwords.length) startPayload.hotwords = options.hotwords
        if (options.disableAi) startPayload.disable_ai = true
        socket.send(JSON.stringify(startPayload))
        for (const chunk of chunks) socket.send(chunk.slice(0))
        socket.send(JSON.stringify({ cmd: 'stop' }))
        return
      }
      if (t === 'final') {
        finalResult = { asrText: String(p.asr_text || ''), llmText: String(p.llm_text || ''), asrMs: Number(p.asr_ms || 0), llmMs: Number(p.llm_ms || 0) }
        return
      }
      if (t === 'done') { if (finalResult) { finished = true; cleanup(); resolve(finalResult) } return }
      if (t === 'error') { finished = true; cleanup(); reject(new Error(String(p.message || '回放失败'))) }
    }
  })
}

/* ── Config ── */
async function loadConfig() {
  const res = await fetch('/api/public/config', { cache: 'no-store' })
  if (!res.ok) throw new Error(`配置接口返回 ${res.status}`)
  state.config = await res.json()
  document.title = state.config.app_name || 'SayIt'
  els.brandName.textContent = state.config.app_name || 'SayIt'
  els.headline.textContent = state.config.headline || '随口说，出色写。'
  els.subheadline.textContent = state.config.subheadline || '用说话代替打字，AI 实时把口语变成可以直接用的书面表达。'
  updateDownloadLinks(state.config.download_url)
  if (els.dlLabel && state.config.download_version) els.dlLabel.textContent = `Windows v${state.config.download_version}`
  const wd = state.config.web_demo || {}
  state.llmEnabled = Boolean(wd.llm_enabled)
  if (!wd.enabled) { els.recordButton.disabled = true; setStateText('未开放', ''); return }
  setStateText('连接中', '')
  if (!state.llmEnabled && els.aiMeta) els.aiMeta.textContent = '当前未启用 AI 校准'
}

/* ── WebSocket ── */
function scheduleReconnect() {
  setTimeout(() => {
    if (!state.ws || state.ws.readyState === WebSocket.CLOSED)
      connectWebSocket().catch(() => setStateText('连接失败', ''))
  }, 2000)
}
async function connectWebSocket() {
  const wsUrl = getWsUrl()
  if (!wsUrl) return
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    socket.binaryType = 'arraybuffer'
    state.ws = socket
    socket.onopen = () => resolve()
    socket.onerror = () => { state.wsReady = false; reject(new Error('WebSocket 连接失败')) }
    socket.onclose = () => {
      state.wsReady = false
      if (!state.recording) setStateText('已断开', '')
      scheduleReconnect()
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let p; try { p = JSON.parse(event.data) } catch (_) { return }
      const t = String(p.type || '')
      if (t === 'ready') {
        state.wsReady = true; state.llmEnabled = Boolean(p.llm)
        setStateText('准备就绪', 'ready')
        return
      }
      if (t === 'asr') {
        const text = String(p.text || '')
        updateResult({ asrText: text, asrMs: p.asr_ms, durationSec: p.duration_sec, placeholder: '正在接收语音...' })
        return
      }
      if (t === 'final') {
        const asr = String(p.asr_text || ''), llm = String(p.llm_text || '')
        const am = Number(p.asr_ms || 0), lm = Number(p.llm_ms || 0)
        const ld = p.llm_debug || {}
        state.lastAsrText = asr; state.lastAiText = llm
        updateResult({
          asrText: asr, llmText: state.llmEnabled ? llm : '', asrMs: am, llmMs: state.llmEnabled ? lm : 0,
          durationSec: p.duration_sec, placeholder: '本次没有识别到有效文本。',
          asrModel: p.asr_model, llmProvider: ld.provider, llmModel: ld.model,
        })
        return
      }
      if (t === 'error') { setStateText('请求失败', ''); return }
      if (t === 'done' && !state.recording) setStateText('准备就绪', 'ready')
    }
  })
}

/* ── Audio ── */
function hasLiveMic(stream) { return stream && stream.getAudioTracks().some(t => t.readyState === 'live') }
function createAudioCtx(Ctor) {
  try { return new Ctor({ latencyHint: 'interactive' }) } catch (_) {}
  return new Ctor()
}
async function teardownAudio() {
  if (state.workletNode) { try { state.workletNode.port.onmessage = null } catch (_) {}; try { state.workletNode.disconnect() } catch (_) {}; state.workletNode = null }
  if (state.sourceNode) { try { state.sourceNode.disconnect() } catch (_) {}; state.sourceNode = null }
  if (state.analyser) { try { state.analyser.disconnect() } catch (_) {}; state.analyser = null }
  if (state.mediaStream) { state.mediaStream.getTracks().forEach(t => t.stop()); state.mediaStream = null }
  if (state.audioCtx) { try { if (state.audioCtx.state !== 'closed') await state.audioCtx.close() } catch (_) {}; state.audioCtx = null }
}
async function ensureAudio() {
  const cs = state.audioCtx ? state.audioCtx.state : 'none'
  const reusable = state.audioCtx && state.workletNode && hasLiveMic(state.mediaStream) && cs !== 'closed' && cs !== 'interrupted'
  if (reusable) { if (cs === 'suspended') await state.audioCtx.resume(); return }
  await teardownAudio()
  state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true } })
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) throw new Error('浏览器不支持 AudioContext')
  state.audioCtx = createAudioCtx(Ctor)
  await state.audioCtx.audioWorklet.addModule('/pcm-worklet.js')
  state.sourceNode = state.audioCtx.createMediaStreamSource(state.mediaStream)
  state.analyser = state.audioCtx.createAnalyser()
  state.analyser.fftSize = 128
  state.analyser.smoothingTimeConstant = 0.85
  state.sourceNode.connect(state.analyser)
  state.workletNode = new AudioWorkletNode(state.audioCtx, 'pcm-processor', {
    numberOfInputs: 1, numberOfOutputs: 0,
    processorOptions: { targetRate: 16000, inputRate: state.audioCtx.sampleRate },
  })
  state.workletNode.port.onmessage = (e) => {
    if (!state.recording) return
    const pcmBuffer = e.data.pcm
    if (!pcmBuffer || pcmBuffer.byteLength === 0) return
    state.pcmChunks.push(pcmBuffer.slice(0))
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(pcmBuffer)
    }
  }
  state.sourceNode.connect(state.workletNode)
  if (state.audioCtx.state === 'suspended') await state.audioCtx.resume()
}

/* ── Recording ── */
async function startRecording() {
  if (!state.config?.web_demo?.enabled || state.recording) return
  if (!state.wsReady || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    setStateText('服务未就绪', ''); return
  }
  await ensureAudio()
  state.pcmChunks = []
  state.recording = true
  state.lastAsrText = ''; state.lastAiText = ''
  setRecordUI(true)
  setStateText('录音中', 'recording')
  // Show result section, hide playback & clear
  els.resultSection.classList.remove('hidden')
  if (els.aiResultSection) els.aiResultSection.classList.remove('hidden')
  els.playbackSection.classList.add('hidden')
  els.clearWrap.classList.add('hidden')
  // Reset results
  updateResult({ placeholder: '正在接收语音...' })
  resetTimer(); startTimer(); startBlob()
  state.ws.send(JSON.stringify({ cmd: 'start', disable_ai: !state.llmEnabled }))
}
async function stopRecording() {
  if (!state.recording) return
  state.recording = false
  setRecordUI(false)
  setStateText('处理中', '')
  clearInterval(state.timerId); state.timerId = null
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ cmd: 'stop' }))
  setupPlayback()
  // Show clear button
  els.clearWrap.classList.remove('hidden')
}

/* ── Clear / Reset ── */
function clearResults() {
  // Hide all result sections
  els.resultSection.classList.add('hidden')
  if (els.aiResultSection) els.aiResultSection.classList.add('hidden')
  els.playbackSection.classList.add('hidden')
  els.clearWrap.classList.add('hidden')
  // Reset state
  state.pcmChunks = []
  state.lastAsrText = ''; state.lastAiText = ''
  if (state.audioEl) { state.audioEl.pause(); URL.revokeObjectURL(state.audioEl.src); state.audioEl = null }
  // Reset timer display
  els.timer.textContent = '00:00'
  setStateText('准备就绪', 'ready')
}

/* ── Copy ── */
async function copyCard(textEl, btn) {
  const text = String(textEl.textContent || '').trim()
  if (!text || textEl.classList.contains('placeholder')) return
  await navigator.clipboard.writeText(text)
  btn.dataset.tooltip = '已复制'
  btn.classList.add('copied')
  setTimeout(() => { btn.classList.remove('copied'); btn.dataset.tooltip = '复制文本' }, 1500)
}

/* ── Rerun ASR ── */
async function rerunAsr() {
  if (!state.pcmChunks.length) return
  updateResult({ placeholder: '正在重新识别...', status: '重新识别中' })
  try {
    const hwText = (els.hotwordInput.value || '').trim()
    const hotwords = hwText ? hwText.split(/[,，]/).map(s => s.trim()).filter(Boolean) : undefined
    const result = await replayAudio({ hotwords, disableAi: true })
    state.lastAsrText = result.asrText
    updateResult({ asrText: result.asrText, asrMs: result.asrMs, durationSec: result.durationSec, placeholder: '本次没有识别到有效文本。' })
  } catch (e) {
    updateResult({ placeholder: e.message, status: '识别失败' })
  }
}

/* ── Rerun LLM ── */
async function rerunLlm() {
  if (!state.pcmChunks.length) return
  updateResult({ placeholder: '正在重新润色...', status: '重新润色中' })
  try {
    const hwText = (els.hotwordInput.value || '').trim()
    const hotwords = hwText ? hwText.split(/[,，]/).map(s => s.trim()).filter(Boolean) : undefined
    const systemPrompt = PROMPTS[state.promptMode] || PROMPTS.faithful
    const result = await replayAudio({ hotwords, systemPrompt })
    state.lastAiText = result.llmText
    state.lastAsrText = result.asrText
    updateResult({ asrText: result.asrText, llmText: result.llmText, asrMs: result.asrMs, llmMs: result.llmMs, durationSec: result.durationSec, placeholder: '未生成结果。' })
  } catch (e) {
    updateResult({ placeholder: e.message, status: '润色失败' })
  }
}

/* ── Prompt mode ── */
function setPromptMode(mode) {
  state.promptMode = mode
  els.mFaithful.classList.toggle('active', mode === 'faithful')
  els.mIntent.classList.toggle('active', mode === 'intent')
}

/* ── Boot ── */
async function boot() {
  // Init gooey blob
  initBars()
  initOrbs(BLOB_CFG.orbCount)
  startBlob()

  // Copy buttons
  if (els.copyResult) els.copyResult.addEventListener('click', () => void copyCard(els.resultText, els.copyResult).catch(() => {}))

  // Record button
  els.recordButton.addEventListener('click', () => {
    void (state.recording ? stopRecording() : startRecording()).catch(e => {
      state.recording = false; setRecordUI(false)
      clearInterval(state.timerId); state.timerId = null
      setStateText('录音失败', '')
      console.error('Recording error:', e)
    })
  })

  // Clear button
  els.clearBtn.addEventListener('click', clearResults)

  // Playback controls
  els.playBtn.addEventListener('click', () => {
    const a = state.audioEl; if (!a) return
    if (a.paused) { a.play(); setPlayUI(true) } else { a.pause(); setPlayUI(false) }
  })
  els.trackInput.addEventListener('input', () => {
    const a = state.audioEl; if (!a || !a.duration) return
    a.currentTime = parseFloat(els.trackInput.value) * a.duration
    const pct = parseFloat(els.trackInput.value) * 100
    els.trackFill.style.width = pct + '%'
    els.trackThumb.style.left = pct + '%'
    els.playTime.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration)}`
  })

  // Playback rate buttons
  document.getElementById('rateBtns')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.rate-btn'); if (!btn) return
    const rate = parseFloat(btn.dataset.rate)
    document.querySelectorAll('.rate-btn').forEach(b => b.classList.toggle('active', b === btn))
    if (state.audioEl) state.audioEl.playbackRate = rate
  })

  // Download audio
  document.getElementById('dlAudioBtn')?.addEventListener('click', () => {
    if (!state.wavBlob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(state.wavBlob)
    a.download = `sayit_${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.wav`
    a.click()
    URL.revokeObjectURL(a.href)
  })

  // Rerun buttons
  if (els.rerunAsr) els.rerunAsr.addEventListener('click', () => void rerunAsr())
  if (els.rerunLlm) els.rerunLlm.addEventListener('click', () => void rerunLlm())

  // Prompt mode buttons
  if (els.mFaithful) els.mFaithful.addEventListener('click', () => setPromptMode('faithful'))
  if (els.mIntent) els.mIntent.addEventListener('click', () => setPromptMode('intent'))

  try {
    await loadConfig()
    if (state.config?.web_demo?.enabled) await connectWebSocket()
  } catch (e) {
    setStateText('初始化失败', '')
    console.error('Boot error:', e)
  }
}
boot()
