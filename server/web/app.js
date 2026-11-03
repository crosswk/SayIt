/* SayIt public site: download link, tabs, hero replay, and the browser demo.
   All copy that crawlers should see lives in the HTML (server/site/build.mjs).
   This file only holds strings for runtime states. */

const LOCALE = (document.documentElement.lang || 'en').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'

// iPads also say "Macintosh" in their UA; touch points tell them apart. SayIt doesn't run on an iPad,
// so it keeps the static Windows-first look rather than pushing a dmg it can't open.
const onMac = /Macintosh/.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1)

// Each visitor's own platform gets the accent. Swapping classes, not order, so nothing moves after load.
if (onMac) {
  document.querySelectorAll('[data-dl-platform]').forEach((a) => {
    const mine = a.dataset.dlPlatform === 'mac'
    a.classList.toggle('btn-accent', mine)
    a.classList.toggle('btn-standard', !mine)
  })
}

const MESSAGES = {
  en: {
    'status.unavailable': 'Demo offline',
    'status.connecting': 'Connecting…',
    'status.connectionFailed': 'Could not connect',
    'overlay.listening': 'Listening…',
    'status.disconnected': 'Disconnected, retrying…',
    'status.busy': 'Busy right now, retrying shortly…',
    'status.retry': 'Could not connect. Press record to try again.',
    'status.dropped': 'Connection lost while recording',
    'status.rejected': 'Not available on this address',
    'status.insecure': 'Needs an HTTPS page',
    'status.quota': 'Demo limit reached for now',
    'status.ready': 'Ready',
    'status.requestFailed': 'Request failed',
    'status.recording': 'Listening…',
    'status.processing': 'Transcribing…',
    'status.recordingFailed': 'Could not start recording',
    'status.micDenied': 'Microphone access is blocked',
    'status.initFailed': 'Could not load the demo',
    'demo.start': 'Start recording',
    'demo.stop': 'Stop recording',
    'demo.offline': 'The online demo is offline right now. The desktop app works on its own.',
    'demo.rejected': 'The online demo can’t be used from this address. The desktop app works on its own.',
    'demo.insecure': 'Browsers only allow recording on HTTPS pages. Open this site from an https:// address to try it.',
    'result.receiving': 'Receiving audio…',
    // Not "no speech was recognized": an empty result can also mean the call failed on the way
    // (quota exhausted, server closed the stream). Naming a cause we did not verify sends people
    // off to debug a microphone that works fine.
    'result.empty': 'No text came back for this recording.',
    // The app's recording.remainingSeconds.
    'timer.remaining': '{s}s left',
    'result.labelRaw': 'Result',
    'result.labelAi': 'Cleaned up by AI',
    'result.aiFailed': 'AI cleanup did not go through this time, so this is the raw transcript.',
    'result.audio': 'Audio {s} s',
    'result.asr': 'Recognition {s} s',
    'result.ai': 'AI cleanup {s} s',
    'copy.copy': 'Copy text',
    'copy.copied': 'Copied',
    'error.audioContext': 'This browser cannot record audio here.',
  },
  'zh-CN': {
    'status.unavailable': '暂未开放',
    'status.connecting': '连接中…',
    'status.connectionFailed': '连接失败',
    'overlay.listening': '正在聆听…',
    'status.disconnected': '已断开，正在重连…',
    'status.busy': '体验的人有点多，稍后自动重试…',
    'status.retry': '没连上，点录音按钮再试一次',
    'status.dropped': '录音时连接断了',
    'status.rejected': '当前网址用不了在线体验',
    'status.insecure': '需要 HTTPS 页面',
    'status.quota': '体验次数暂时用完了',
    'status.ready': '准备就绪',
    'status.requestFailed': '请求失败',
    'status.recording': '正在听…',
    'status.processing': '识别中…',
    'status.recordingFailed': '录音没能开始',
    'status.micDenied': '麦克风权限被拦住了',
    'status.initFailed': '在线体验加载失败',
    'demo.start': '开始录音',
    'demo.stop': '结束录音',
    'demo.offline': '在线体验暂时关闭了，桌面客户端不受影响。',
    'demo.rejected': '当前网址暂时用不了在线体验，桌面客户端不受影响。',
    'demo.insecure': '浏览器只允许在 HTTPS 页面里录音，换成 https:// 开头的网址再试。',
    'result.receiving': '正在接收语音…',
    'result.empty': '这次没有返回文字。',
    'timer.remaining': '剩余 {s}s',
    'result.labelRaw': '识别结果',
    'result.labelAi': 'AI 整理后',
    'result.aiFailed': '这次 AI 整理没成功，显示的是识别原文。',
    'result.audio': '语音 {s} 秒',
    'result.asr': '识别 {s} 秒',
    'result.ai': 'AI 整理 {s} 秒',
    'copy.copy': '复制文本',
    'copy.copied': '已复制',
    'error.audioContext': '这个浏览器在这里录不了音。',
  },
}

const tr = (key, vars = {}) => {
  const template = MESSAGES[LOCALE][key] ?? MESSAGES.en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
}
const $ = (id) => document.getElementById(id)
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

/* ── Tabs (selector bar, Settings nav, mode radio cards) ─────────────────── */

function initTabs(list) {
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'))
  const vertical = list.getAttribute('aria-orientation') === 'vertical'
  const panelOf = (tab) => document.getElementById(tab.getAttribute('aria-controls'))
  const select = (tab, focus) => {
    tabs.forEach((t) => {
      const on = t === tab
      t.setAttribute('aria-selected', String(on))
      t.tabIndex = on ? 0 : -1
      const panel = panelOf(t)
      if (panel) panel.hidden = !on
    })
    if (focus) tab.focus({ preventScroll: true })
  }
  // Keep the chosen item visible when the list scrolls sideways on small screens. Scroll only the
  // list itself: scrollIntoView would also scroll the page, and on load that jumps past the hero.
  const reveal = (tab) => {
    if (list.scrollWidth <= list.clientWidth) return
    const left = tab.offsetLeft - list.offsetLeft
    const right = left + tab.offsetWidth
    if (left < list.scrollLeft) list.scrollLeft = left - 8
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + 8
  }
  // Without JavaScript every panel stays visible (and readable by crawlers); with it, one at a time.
  select(tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0], false)
  list.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]')
    if (!tab) return
    select(tab, false)
    reveal(tab)
  })
  list.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement)
    if (i < 0) return
    const next = vertical ? ['ArrowDown', 'ArrowRight'] : ['ArrowRight']
    const prev = vertical ? ['ArrowUp', 'ArrowLeft'] : ['ArrowLeft']
    let j = -1
    if (next.includes(e.key)) j = (i + 1) % tabs.length
    else if (prev.includes(e.key)) j = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = tabs.length - 1
    if (j < 0) return
    e.preventDefault()
    select(tabs[j], true)
    reveal(tabs[j])
  })
}

/* ── Overlay waveform: client/src/services/waveform.ts computeBarsFromPCM, ported ──
   Every bar is the RMS of one slice of the same audio frame, through an adaptive gain, a tanh
   soft clip and a slight centre bias, then smoothed: fast attack (0.45), slow decay (0.12).
   That is why the real bars rise together with the voice and sink gently; independent random
   heights (the previous version) flicker instead. Keep the constants identical to the app. */
const WAVE = { minHeight: 3, maxHeight: 18, attack: 0.45, decay: 0.12, centerShape: 0.15, gainTarget: 0.7, softClip: 1.5 }
const makeWave = (n) => ({ prev: Array(n).fill(WAVE.minHeight), peak: 0.05 })
const resetWave = (s) => {
  s.prev.fill(WAVE.minHeight)
  s.peak = 0.05
}
function stepWave(s, sliceRms, frameRms) {
  if (frameRms > s.peak) s.peak += (frameRms - s.peak) * 0.3
  else s.peak += (frameRms - s.peak) * 0.005
  s.peak = Math.max(0.02, Math.min(0.5, s.peak))
  const gain = WAVE.gainTarget / s.peak
  const n = s.prev.length
  const center = (n - 1) / 2
  for (let i = 0; i < n; i++) {
    const normalized = Math.tanh(sliceRms[i] * gain * WAVE.softClip)
    const shape = Math.max(0.7, 1 - (Math.abs(i - center) / Math.max(1, center)) * WAVE.centerShape)
    const target = Math.max(WAVE.minHeight, normalized * WAVE.maxHeight * shape)
    const prev = s.prev[i]
    s.prev[i] = target > prev ? prev + (target - prev) * WAVE.attack : prev + (target - prev) * WAVE.decay
  }
  return s.prev
}
function barsFromPcm(pcm, s) {
  const n = s.prev.length
  if (!pcm.length) return s.prev
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2
  const per = Math.max(1, Math.floor(pcm.length / n))
  const slices = new Array(n)
  for (let i = 0; i < n; i++) {
    const start = i * per
    const end = i === n - 1 ? pcm.length : Math.min(pcm.length, start + per)
    let acc = 0
    for (let j = start; j < end; j++) acc += (pcm[j] / 32768) ** 2
    slices[i] = Math.sqrt(acc / Math.max(1, end - start))
  }
  return stepWave(s, slices, Math.sqrt(sum / pcm.length))
}
// Slices of one speech frame differ a lot (pitch periods fall across them); silence is flat noise.
const synthSlices = (frame, n) => Array.from({ length: n }, () => frame * (0.45 + Math.random() * 1.1))
function paintBars(els, heights) {
  for (let i = 0; i < els.length; i++) {
    const h = Math.round(heights[i] ?? WAVE.minHeight)
    els[i].style.height = `${h}px`
    els[i].style.opacity = (0.7 + (Math.min(18, h) / 18) * 0.3).toFixed(2)
  }
}

/* ── Hero replay ─────────────────────────────────────────────────────────── */

/* The stage replays what the app does, phase for phase (client/src/overlay/Overlay.tsx):
   preparing (three dots in a 48px pill) -> listening (bars follow the voice; the live caption
   grows a few characters at a time, the way streaming ASR delivers partial results) ->
   processing (the progress track) -> the overlay hides and the clean text is pasted in one go.
   The old version typed character by character into a growing, re-centring bubble with
   strike-throughs; the owner found it jittery and unlike the app (2026-10-13).
   Clicking a tab stops the replay and shows that tab's finished frame. */
function initReplay() {
  const fig = document.querySelector('[data-replay]')
  if (!fig) return
  const tabs = Array.from(fig.querySelectorAll('.switcher [role="tab"]'))
  const panes = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')))
  const cap = fig.querySelector('.ov-cap')
  const capText = fig.querySelector('[data-cap-text]')
  const bars = Array.from(fig.querySelectorAll('.ov-bars i'))
  const timer = fig.querySelector('[data-timer]')
  if (!tabs.length || panes.some((p) => !p) || !cap || !capText || !timer) return

  const scripts = tabs.map((tab, i) => {
    const typed = panes[i].querySelector('[data-typed]')
    return { typedEl: typed, typed: typed.textContent || '', said: tab.dataset.said || '', secs: Number(tab.dataset.secs) || 0 }
  })
  const rest = bars.map((b) => [b.style.height, b.style.opacity])
  const byChar = LOCALE === 'zh-CN'
  const sim = makeWave(bars.length)
  let run = 0
  let tick = 0
  let wave = 0
  let level = 0
  let speaking = false

  // Partial results arrive two to four characters (or one or two words) at a time.
  const chunks = (text) => {
    const out = []
    if (byChar) {
      const ch = Array.from(text)
      for (let i = 0; i < ch.length;) {
        const n = 2 + Math.floor(Math.random() * 3)
        out.push(ch.slice(i, i + n).join(''))
        i += n
      }
    } else {
      const words = text.split(/(?<=\s)/)
      for (let i = 0; i < words.length;) {
        const n = 1 + Math.floor(Math.random() * 2)
        out.push(words.slice(i, i + n).join(''))
        i += n
      }
    }
    return out
  }
  // A synthetic voice fed through the app's own bar algorithm every 33ms (the app's frame rate):
  // syllables at ~4 per second while speaking, near-silence in the pauses.
  const startWave = () => {
    clearInterval(wave)
    resetWave(sim)
    const t0 = performance.now()
    wave = setInterval(() => {
      const t = (performance.now() - t0) / 1000
      const syllable = 0.35 + 0.65 * Math.abs(Math.sin(t * Math.PI * 4.2 + Math.sin(t * 1.7)))
      const frame = speaking ? level * syllable * (0.85 + Math.random() * 0.3) : 0.002 + Math.random() * 0.002
      paintBars(bars, stepWave(sim, synthSlices(frame, bars.length), frame))
    }, 33)
  }
  const stopWave = (atRest) => {
    clearInterval(wave)
    bars.forEach((b, i) => {
      b.style.height = atRest ? rest[i][0] : '3px'
      b.style.opacity = atRest ? rest[i][1] : '0.75'
    })
  }
  const show = (i) =>
    tabs.forEach((t, j) => {
      const on = j === i
      t.setAttribute('aria-selected', String(on))
      t.tabIndex = on ? 0 : -1
      panes[j].hidden = !on
    })
  const finish = (i) => {
    const s = scripts[i]
    show(i)
    cap.classList.remove('is-empty')
    capText.textContent = s.said
    s.typedEl.textContent = s.typed
    timer.textContent = `${s.secs}s`
    stopWave(true)
  }

  const wait = (ms, id) =>
    new Promise((resolve, reject) => setTimeout(() => (id === run ? resolve() : reject(new Error('cancelled'))), ms))

  async function playTab(i, id) {
    const s = scripts[i]
    show(i)
    fig.dataset.state = 'idle'
    s.typedEl.textContent = ''
    s.typedEl.classList.remove('is-pasted')
    cap.classList.add('is-empty')
    capText.textContent = tr('overlay.listening')
    timer.textContent = '0s'
    stopWave(false)
    await wait(700, id)
    fig.dataset.state = 'preparing'
    await wait(380, id)
    fig.dataset.state = 'listening'
    speaking = false
    startWave()
    const started = performance.now()
    clearInterval(tick)
    tick = setInterval(() => {
      timer.textContent = `${Math.floor((performance.now() - started) / 1000)}s`
    }, 250)
    await wait(450, id)
    let shown = ''
    for (const c of chunks(s.said)) {
      speaking = true
      level = 0.05 + Math.random() * 0.04
      await wait((byChar ? 200 : 220) + Math.random() * 120, id)
      shown += c
      cap.classList.remove('is-empty')
      capText.textContent = shown
      // A breath after each clause: the bars sink (slowly, as the app's decay does) before the next words.
      if (/[，。、,.]\s*$/.test(c)) {
        speaking = false
        await wait(280, id)
      }
    }
    speaking = false
    await wait(650, id)
    clearInterval(tick)
    stopWave(false)
    fig.dataset.state = 'thinking'
    await wait(1300, id)
    fig.dataset.state = 'done'
    await wait(180, id)
    s.typedEl.textContent = s.typed
    s.typedEl.classList.add('is-pasted')
    await wait(2600, id)
  }

  /* Plays Claude Code -> Codex -> Kiro and starts over, for as long as the page is open (owner,
     2026-10-18: no replay button, keep cycling). It waits while the stage is off screen or the tab
     is hidden, so a page left open in the background does not keep animating. */
  let onScreen = false
  let wake = null
  const visible = () => onScreen && !document.hidden
  const whenVisible = (id) =>
    visible()
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
        wake = () => (id === run ? resolve() : reject(new Error('cancelled')))
      })
  const nudge = () => {
    if (wake && visible()) {
      const w = wake
      wake = null
      w()
    }
  }

  async function play(from = 0) {
    const id = ++run
    if (wake) {
      // A pending wait belongs to the run this one replaces.
      const w = wake
      wake = null
      w()
    }
    try {
      for (let i = from; ; i = (i + 1) % scripts.length) {
        await whenVisible(id)
        await playTab(i, id)
      }
    } catch (_) {
      /* a newer run took over: a tab was clicked */
    } finally {
      if (id === run) {
        clearInterval(tick)
        clearInterval(wave)
      }
    }
  }

  // Picking a tool plays it now, then the loop carries on from there.
  const pick = (i, focus) => {
    clearInterval(tick)
    if (focus) tabs[i].focus({ preventScroll: true })
    if (reduceMotion.matches) {
      run++
      finish(i)
      fig.dataset.state = 'summary'
      return
    }
    void play(i)
  }
  tabs.forEach((t, i) => t.addEventListener('click', () => pick(i, false)))
  fig.querySelector('.switcher').addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement)
    if (i < 0) return
    const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1
    if (j < 0) return
    e.preventDefault()
    pick(j, true)
  })

  if (reduceMotion.matches || !('IntersectionObserver' in window)) return
  let started = false
  const io = new IntersectionObserver(
    (entries) => {
      onScreen = entries.some((e) => e.isIntersecting)
      if (onScreen && !started) {
        started = true
        void play()
      }
      nudge()
    },
    { threshold: 0.3 },
  )
  io.observe(fig)
  document.addEventListener('visibilitychange', nudge)
}

/* ── Copy helpers ────────────────────────────────────────────────────────── */

async function copyText(text, btn) {
  if (!text) return
  await navigator.clipboard.writeText(text)
  btn.classList.add('is-copied')
  btn.setAttribute('aria-label', tr('copy.copied'))
  btn.title = tr('copy.copied')
  setTimeout(() => {
    btn.classList.remove('is-copied')
    btn.setAttribute('aria-label', tr('copy.copy'))
    btn.title = tr('copy.copy')
  }, 1500)
}

function initTerminalCopy() {
  const btn = document.querySelector('[data-copy-terminal]')
  if (!btn || !navigator.clipboard) return
  btn.hidden = false
  btn.addEventListener('click', () => {
    const lines = Array.from(document.querySelectorAll('.term-body .t-line'))
      .filter((l) => !l.classList.contains('t-c'))
      .map((l) => (l.textContent || '').replace(/^\$\s*/, ''))
    void copyText(lines.join('\n'), btn).catch(() => { })
  })
}

/* ── Browser demo ────────────────────────────────────────────────────────── */

const els = {
  recordButton: $('recordButton'),
  stateText: $('stateText'),
  stateDot: $('stateDot'),
  timer: $('timer'),
  bars: $('demoBars'),
  resultText: $('resultText'),
  resultLabel: $('resultLabel'),
  resultNote: $('resultNote'),
  resultMeta: $('resultMeta'),
  resultDetails: $('resultDetails'),
  asrText: $('asrText'),
  copyResult: $('copyResult'),
  playbackSection: $('playbackSection'),
  playBtn: $('playBtn'),
  trackInput: $('trackInput'),
  playTime: $('playTime'),
  dlAudioBtn: $('dlAudioBtn'),
  clearBtn: $('clearBtn'),
}

const state = {
  config: null,
  ws: null,
  wsReady: false,
  recording: false,
  llmEnabled: false,
  mediaStream: null,
  audioCtx: null,
  workletNode: null,
  sourceNode: null,
  analyser: null,
  timerId: 0,
  timerStarted: 0,
  wave: null,
  waveAt: 0,
  pcmChunks: [],
  wavBlob: null,
  audioEl: null,
  playRaf: 0,
  connecting: null,
  retry: 0,
  retryTimer: 0,
  stopped: false,
}

// Close codes the backend uses (server/backend/app/main.py, _WS_CLOSE_*).
const WS_CLOSE = { idle: 4000, rejected: 4003, perIp: 4029, full: 1013 }
const RETRY_MAX = 5

function setStatus(key, dot = '') {
  if (!els.stateText) return
  els.stateText.textContent = tr(key)
  els.stateDot.className = 'state-dot' + (dot ? ' ' + dot : '')
}

function setRecordUI(recording) {
  els.recordButton.classList.toggle('is-recording', recording)
  els.recordButton.setAttribute('aria-label', tr(recording ? 'demo.stop' : 'demo.start'))
  els.recordButton.setAttribute('aria-pressed', String(recording))
}

/* The site-wide rule (owner, 2026-10-13 / 10-18): a line never holds just one or two characters.
   build.mjs glues the end of every static paragraph; text set here at runtime gets the same
   treatment: the last four characters of the last line (two words in English) in one nowrap run. */
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/
const NO_LINE_START = '，、；：。！？）」』》,.;:!?)'
function setGlued(el, text) {
  const s = String(text ?? '')
  const nl = s.lastIndexOf('\n') + 1
  const ch = Array.from(s.slice(nl))
  el.replaceChildren()
  let cut = -1
  if (CJK_RE.test(ch.join('')) && ch.length > 3) {
    cut = ch.length - (ch.length <= 12 ? 4 : 6)
    while (cut > 0 && /[A-Za-z0-9.\-+]/.test(ch[cut - 1]) && /[A-Za-z0-9.\-+]/.test(ch[cut])) cut--
    while (cut < ch.length - 1 && NO_LINE_START.includes(ch[cut])) cut++
  } else if (ch.length) {
    const sp = ch.join('').trimEnd().lastIndexOf(' ')
    const sp2 = sp > 0 ? ch.join('').lastIndexOf(' ', sp - 1) : -1
    if (sp2 > 0) cut = Array.from(ch.join('').slice(0, sp2 + 1)).length
  }
  if (cut <= 0) {
    el.textContent = s
    return
  }
  const span = document.createElement('span')
  span.className = 'nb'
  span.textContent = ch.slice(cut).join('')
  el.append(s.slice(0, nl) + ch.slice(0, cut).join(''), span)
}

function setResult(text, { placeholder = false } = {}) {
  const value = String(text || '')
  const empty = placeholder || !value
  setGlued(els.resultText, empty ? value || els.resultText.dataset.placeholder : value)
  els.resultText.classList.toggle('is-placeholder', empty)
  els.copyResult.hidden = empty || !navigator.clipboard
}

// Timings only. Model and provider names are server internals and mean nothing to a visitor
// (owner, 2026-10-19).
function setMeta(opts) {
  els.resultMeta.replaceChildren()
  const add = (text) => {
    const span = document.createElement('span')
    span.className = 'meta-text'
    span.textContent = text
    els.resultMeta.appendChild(span)
  }
  const sec = (ms) => (ms / 1000).toFixed(1)
  if (opts.durationSec) add(tr('result.audio', { s: Number(opts.durationSec).toFixed(1) }))
  if (opts.asrMs) add(tr('result.asr', { s: sec(opts.asrMs) }))
  if (opts.llmMs) add(tr('result.ai', { s: sec(opts.llmMs) }))
}

function showRaw(asr, llm) {
  const show = Boolean(asr && llm && asr !== llm)
  els.resultDetails.hidden = !show
  setGlued(els.asrText, show ? asr : '')
}

// The label says what the text is: cleaned up by AI, or the raw transcript. When cleanup was on but
// failed, the server still returns the transcript; say so instead of passing it off as cleaned up.
function setResultKind(kind) {
  if (els.resultLabel) els.resultLabel.textContent = tr(kind === 'ai' ? 'result.labelAi' : 'result.labelRaw')
  if (!els.resultNote) return
  els.resultNote.hidden = kind !== 'aiFailed'
  setGlued(els.resultNote, kind === 'aiFailed' ? tr('result.aiFailed') : '')
}

/* The demo's bars are computed exactly as the app computes them: from each microphone PCM frame
   (barsFromPcm, the port of computeBarsFromPCM), at most every 33ms. Not from the analyser's
   frequency bins, which looked nothing like the app. Out of recording the bars rest at 3px. */
function renderBars() {
  const bars = els.bars ? Array.from(els.bars.children) : []
  if (!state.recording) {
    if (state.wave) resetWave(state.wave)
    paintBars(bars, [])
  }
}
function pushPcmBars(pcm) {
  if (!els.bars) return
  const bars = Array.from(els.bars.children)
  if (!state.wave || state.wave.prev.length !== bars.length) state.wave = makeWave(bars.length)
  const view = pcm instanceof ArrayBuffer ? new Int16Array(pcm) : new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
  const heights = barsFromPcm(view, state.wave)
  const now = performance.now()
  if (now - (state.waveAt || 0) < 33) return
  state.waveAt = now
  paintBars(bars, heights)
}

/* The app's overlay timer (formatRecordingTimer, client/src/services/recorder/types.ts): whole
   seconds as "7s", the time left in the last minute ("剩余 47s"), and at the limit the recording
   stops by itself, as the app does at MAX_RECORDING_SEC = 300 (owner, 2026-10-19: five minutes, the
   same as the app). The limit is the server's web_demo.max_duration_sec, which rejects anything
   longer; without stopping here a visitor could talk past it and only then be told it was too long.
   It stops half a second early because the audio runs a tick behind the clock. */
const COUNTDOWN_SEC = 60
const demoLimitSec = () => Number(state.config?.web_demo?.max_duration_sec) || 300
function resetTimer() {
  els.timer.textContent = '0s'
  els.timer.classList.remove('is-countdown', 'is-urgent')
}
/* Once stopped, the app's overlay leaves the timer for the processing bar; this pill stays, so it
   settles on the length of the take. A pulsing "剩余 1s" left behind would read as still counting. */
function freezeTimer() {
  if (!state.timerStarted) return
  // Rounded, so the take that hit the limit (stopped 0.5s early) reads "300s", not "299s".
  els.timer.textContent = `${Math.round((performance.now() - state.timerStarted) / 1000)}s`
  els.timer.classList.remove('is-countdown', 'is-urgent')
  state.timerStarted = 0
}
function startTimer() {
  const started = performance.now()
  const limit = demoLimitSec()
  resetTimer()
  state.timerStarted = started
  state.timerId = setInterval(() => {
    const ms = performance.now() - started
    const elapsed = Math.floor(ms / 1000)
    const left = Math.max(0, limit - elapsed)
    const countdown = left <= COUNTDOWN_SEC
    els.timer.textContent = countdown ? tr('timer.remaining', { s: left }) : `${elapsed}s`
    els.timer.classList.toggle('is-countdown', countdown)
    els.timer.classList.toggle('is-urgent', countdown && left <= 10)
    if (ms >= limit * 1000 - 500 && state.recording) stopRecording()
  }, 250)
}

/* WAV from captured 16 kHz PCM, for playback and download. */
function createWavBlob(chunks, sampleRate) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  if (total <= 0) return null
  const buffer = new ArrayBuffer(44 + total)
  const view = new DataView(buffer)
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); view.setUint32(4, 36 + total, true); str(8, 'WAVE'); str(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, total, true)
  const out = new Uint8Array(buffer, 44)
  let offset = 0
  for (const c of chunks) { out.set(new Uint8Array(c), offset); offset += c.byteLength }
  return new Blob([buffer], { type: 'audio/wav' })
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
function setupPlayback() {
  const blob = createWavBlob(state.pcmChunks, 16000)
  if (!blob) return
  state.wavBlob = blob
  if (state.audioEl) { state.audioEl.pause(); URL.revokeObjectURL(state.audioEl.src) }
  const audio = new Audio(URL.createObjectURL(blob))
  audio.preload = 'auto'
  const rate = document.querySelector('.rate[aria-pressed="true"]')
  audio.playbackRate = rate ? Number(rate.dataset.rate) : 1
  state.audioEl = audio
  els.playbackSection.hidden = false
  els.trackInput.value = '0'
  els.playTime.textContent = '0:00 / 0:00'
  audio.addEventListener('loadedmetadata', () => { els.playTime.textContent = `0:00 / ${fmtTime(audio.duration)}` })
  audio.addEventListener('ended', () => setPlaying(false))
}
function setPlaying(playing) {
  els.playBtn.classList.toggle('is-playing', playing)
  cancelAnimationFrame(state.playRaf)
  if (!playing) return
  const step = () => {
    const a = state.audioEl
    if (!a) return
    els.trackInput.value = String(a.duration ? Math.round((a.currentTime / a.duration) * 1000) : 0)
    els.playTime.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration || 0)}`
    if (!a.paused) state.playRaf = requestAnimationFrame(step)
  }
  state.playRaf = requestAnimationFrame(step)
}

/* Server connection.
   The old loop reconnected every 2 s forever, whatever the reason for the close. When the server
   refuses this page (guard: Origin not on the allow-list, code 4003) that is an endless
   "Disconnected, retrying…" that also hammers the server. Now: a refusal stops for good, an idle
   close waits for the next click, anything else backs off and gives up after RETRY_MAX tries. */
function wsUrl() {
  const demo = state.config && state.config.web_demo
  if (!demo || !demo.ws_url) return null
  const target = new URL(demo.ws_url, window.location.origin)
  target.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return target.toString()
}

function canRecordHere() {
  return Boolean(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
}

function setOffline(statusKey, messageKey) {
  state.stopped = true
  els.recordButton.disabled = true
  setStatus(statusKey)
  setResult(tr(messageKey), { placeholder: true })
}

function scheduleReconnect(code) {
  clearTimeout(state.retryTimer)
  if (state.stopped) return
  if (code === WS_CLOSE.idle) {
    // Reaped after minutes of silence. Reconnect when the visitor actually presses record.
    els.recordButton.disabled = false
    setStatus('status.ready', 'ready')
    return
  }
  if (state.retry >= RETRY_MAX) {
    els.recordButton.disabled = false
    setStatus('status.retry')
    return
  }
  const busy = code === WS_CLOSE.perIp || code === WS_CLOSE.full
  const delay = Math.min(20000, (busy ? 5000 : 1500) * 2 ** state.retry)
  state.retry += 1
  setStatus(busy ? 'status.busy' : 'status.disconnected', 'busy')
  const run = () => {
    if (document.hidden) {
      document.addEventListener('visibilitychange', run, { once: true })
      return
    }
    connect().catch(() => { })
  }
  state.retryTimer = setTimeout(run, delay)
}

/* Resolves once the server says "ready", not merely when the socket opens. */
function connect() {
  const url = wsUrl()
  if (!url) return Promise.reject(new Error('no ws url'))
  if (state.ws && state.ws.readyState === WebSocket.OPEN && state.wsReady) return Promise.resolve()
  if (state.connecting) return state.connecting
  setStatus('status.connecting', 'busy')
  state.connecting = new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    state.ws = socket
    const done = (err) => {
      state.connecting = null
      clearTimeout(timeout)
      err ? reject(err) : resolve()
    }
    const timeout = setTimeout(() => { done(new Error('timeout')); try { socket.close() } catch (_) { } }, 10000)
    socket.onerror = () => { state.wsReady = false }
    socket.onclose = (ev) => {
      if (state.ws !== socket) return
      const wasRecording = state.recording
      state.wsReady = false
      els.recordButton.disabled = true
      done(new Error(`closed ${ev.code}`))
      if (wasRecording) {
        // The audio is still in memory: stop cleanly so it can be played back and downloaded.
        state.recording = false
        setRecordUI(false)
        clearInterval(state.timerId)
        freezeTimer()
        renderBars()
        setupPlayback()
        els.clearBtn.hidden = false
      }
      if (ev.code === WS_CLOSE.rejected) {
        setOffline('status.rejected', 'demo.rejected')
        return
      }
      scheduleReconnect(ev.code)
      if (wasRecording) setStatus('status.dropped')
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      let p
      try { p = JSON.parse(event.data) } catch (_) { return }
      const type = String(p.type || '')
      if (type === 'ready') {
        state.wsReady = true
        state.retry = 0
        state.llmEnabled = Boolean(p.llm)
        els.recordButton.disabled = false
        setStatus('status.ready', 'ready')
        done()
      } else if (type === 'asr') {
        setResult(String(p.text || '') || tr('result.receiving'), { placeholder: !p.text })
        setMeta({ asrMs: p.asr_ms, durationSec: p.duration_sec })
      } else if (type === 'final') {
        const asr = String(p.asr_text || '')
        const llm = state.llmEnabled ? String(p.llm_text || '') : ''
        const debug = p.llm_debug || {}
        if (llm || asr) setResult(llm || asr)
        else setResult(tr('result.empty'), { placeholder: true })
        showRaw(asr, llm)
        // llm_debug.provider is only set when cleanup ran; .error when it was tried and failed.
        setResultKind(!asr ? 'raw' : debug.provider ? 'ai' : state.llmEnabled && debug.error ? 'aiFailed' : 'raw')
        setMeta({
          asrMs: Number(p.asr_ms || 0),
          llmMs: state.llmEnabled ? Number(p.llm_ms || 0) : 0,
          durationSec: p.duration_sec,
        })
      } else if (type === 'error') {
        // "rejected" is followed by a 4003 close, handled above. Quota messages from the server
        // are Chinese only, so the English page uses its own wording.
        if (p.code === 'quota') {
          setStatus('status.quota')
          if (LOCALE === 'zh-CN' && p.message) setResult(String(p.message), { placeholder: true })
        } else if (p.code !== 'rejected') {
          setStatus('status.requestFailed')
        }
      } else if (type === 'done' && !state.recording) {
        setStatus('status.ready', 'ready')
        els.clearBtn.hidden = false
      }
    }
  })
  return state.connecting
}

/* Audio capture */
const hasLiveMic = (s) => s && s.getAudioTracks().some((t) => t.readyState === 'live')
async function teardownAudio() {
  try { if (state.workletNode) { state.workletNode.port.onmessage = null; state.workletNode.disconnect() } } catch (_) { }
  try { if (state.sourceNode) state.sourceNode.disconnect() } catch (_) { }
  try { if (state.analyser) state.analyser.disconnect() } catch (_) { }
  if (state.mediaStream) state.mediaStream.getTracks().forEach((t) => t.stop())
  try { if (state.audioCtx && state.audioCtx.state !== 'closed') await state.audioCtx.close() } catch (_) { }
  Object.assign(state, { workletNode: null, sourceNode: null, analyser: null, mediaStream: null, audioCtx: null })
}
async function ensureAudio() {
  const cs = state.audioCtx ? state.audioCtx.state : 'none'
  if (state.audioCtx && state.workletNode && hasLiveMic(state.mediaStream) && cs !== 'closed' && cs !== 'interrupted') {
    if (cs === 'suspended') await state.audioCtx.resume()
    return
  }
  await teardownAudio()
  state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true } })
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) throw new Error(tr('error.audioContext'))
  try { state.audioCtx = new Ctor({ latencyHint: 'interactive' }) } catch (_) { state.audioCtx = new Ctor() }
  await state.audioCtx.audioWorklet.addModule('/pcm-worklet.js')
  state.sourceNode = state.audioCtx.createMediaStreamSource(state.mediaStream)
  state.analyser = state.audioCtx.createAnalyser()
  state.analyser.fftSize = 128
  state.analyser.smoothingTimeConstant = 0.8
  state.sourceNode.connect(state.analyser)
  state.workletNode = new AudioWorkletNode(state.audioCtx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: { targetRate: 16000, inputRate: state.audioCtx.sampleRate },
  })
  state.workletNode.port.onmessage = (e) => {
    if (!state.recording) return
    const pcm = e.data && e.data.pcm
    if (!pcm || pcm.byteLength === 0) return
    state.pcmChunks.push(pcm.slice(0))
    pushPcmBars(pcm)
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(pcm)
  }
  state.sourceNode.connect(state.workletNode)
  if (state.audioCtx.state === 'suspended') await state.audioCtx.resume()
}

async function startRecording() {
  if (!state.config?.web_demo?.enabled || state.recording || state.stopped) return
  if (!state.wsReady || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
    // After an idle close or a run of failed retries, pressing record is the retry.
    state.retry = 0
    els.recordButton.disabled = true
    try {
      await connect()
    } catch (_) {
      if (!state.stopped) {
        els.recordButton.disabled = false
        setStatus('status.retry')
      }
      return
    }
  }
  await ensureAudio()
  state.pcmChunks = []
  state.recording = true
  setRecordUI(true)
  setStatus('status.recording', 'recording')
  els.playbackSection.hidden = true
  els.clearBtn.hidden = true
  els.resultDetails.hidden = true
  els.resultMeta.replaceChildren()
  setResult(tr('result.receiving'), { placeholder: true })
  setResultKind('raw')
  clearInterval(state.timerId)
  startTimer()
  if (state.wave) resetWave(state.wave)
  state.ws.send(JSON.stringify({ cmd: 'start', disable_ai: !state.llmEnabled }))
}

function stopRecording() {
  if (!state.recording) return
  state.recording = false
  setRecordUI(false)
  setStatus('status.processing', 'busy')
  clearInterval(state.timerId)
  freezeTimer()
  renderBars()
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ cmd: 'stop' }))
  setupPlayback()
  els.clearBtn.hidden = false
}

function clearResults() {
  els.playbackSection.hidden = true
  els.clearBtn.hidden = true
  els.resultDetails.hidden = true
  els.resultMeta.replaceChildren()
  setResult('', { placeholder: true })
  setResultKind('raw')
  state.pcmChunks = []
  if (state.audioEl) { state.audioEl.pause(); URL.revokeObjectURL(state.audioEl.src); state.audioEl = null }
  setPlaying(false)
  resetTimer()
  if (state.wsReady) setStatus('status.ready', 'ready')
}

function initDemo() {
  if (!els.recordButton) return
  setRecordUI(false)
  setStatus('status.connecting', 'busy')

  els.recordButton.addEventListener('click', () => {
    const action = state.recording ? Promise.resolve(stopRecording()) : startRecording()
    action.catch((e) => {
      state.recording = false
      setRecordUI(false)
      clearInterval(state.timerId)
      freezeTimer()
      setStatus(e && e.name === 'NotAllowedError' ? 'status.micDenied' : 'status.recordingFailed')
      console.error('Recording error:', e)
    })
  })
  els.copyResult.addEventListener('click', () => {
    if (els.resultText.classList.contains('is-placeholder')) return
    void copyText(els.resultText.textContent.trim(), els.copyResult).catch(() => { })
  })
  els.clearBtn.addEventListener('click', clearResults)
  els.playBtn.addEventListener('click', () => {
    const a = state.audioEl
    if (!a) return
    if (a.paused) { void a.play(); setPlaying(true) } else { a.pause(); setPlaying(false) }
  })
  els.trackInput.addEventListener('input', () => {
    const a = state.audioEl
    if (!a || !a.duration) return
    a.currentTime = (Number(els.trackInput.value) / 1000) * a.duration
    els.playTime.textContent = `${fmtTime(a.currentTime)} / ${fmtTime(a.duration)}`
  })
  document.querySelector('.rates')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.rate')
    if (!btn) return
    document.querySelectorAll('.rate').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)))
    if (state.audioEl) state.audioEl.playbackRate = Number(btn.dataset.rate)
  })
  els.dlAudioBtn.addEventListener('click', () => {
    if (!state.wavBlob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(state.wavBlob)
    a.download = `sayit_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.wav`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  })
}

/* ── Config: direct download link, version, and whether the demo is open ─── */

async function loadConfig() {
  const res = await fetch('/api/public/config', { cache: 'no-store', headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`config ${res.status}`)
  const cfg = await res.json()
  state.config = cfg
  // Static HTML points at the GitHub release so crawlers and offline copies still work.
  // The server's own download endpoint is faster for most visitors, so prefer it when offered.
  // That endpoint only serves the Windows installer: the Windows buttons always take it, the generic
  // top-bar "Download" only for non-Mac visitors (on a Mac it stays on the GitHub release, where the dmg is).
  if (cfg.download_url) {
    document.querySelectorAll('[data-download-win]').forEach((a) => { a.href = cfg.download_url })
    if (!onMac) document.querySelectorAll('[data-download]').forEach((a) => { a.href = cfg.download_url })
  }
  if (cfg.download_version) {
    document.querySelectorAll('[data-version]').forEach((el) => {
      el.textContent = el.dataset.template.replace('{v}', `v${cfg.download_version}`)
      el.hidden = false
    })
  }
  return cfg
}

/* ── The clickable app (build.mjs appMock) ───────────────────────────────── */

const WAVE_THEME = {
  rainbow: { bar: (t) => `hsl(${140 - Math.round(t * 110)} 95% ${64 - Math.round(Math.abs(t - 0.5) * 12)}%)`, timer: '#fef08a' },
  blue: { bar: (t) => `hsl(${190 + Math.round(t * 30)} 90% ${62 - Math.round(Math.abs(t - 0.5) * 14)}%)`, timer: '#bae6fd' },
  white: { bar: () => '#f1f5f9', timer: '#e5e7eb' },
}
const WAVE_BARS = { short: 12, medium: 18, long: 24 }

function initAppMock() {
  const root = document.querySelector('[data-am]')
  if (!root) return
  const $$ = (sel, el = root) => Array.from(el.querySelectorAll(sel))
  const pages = $$('[data-am-page]')
  const main = root.querySelector('.am-main')
  const modal = root.querySelector('[data-am-modal]')

  const go = (id) => {
    pages.forEach((p) => { p.hidden = p.dataset.amPage !== id })
    $$('.am-nav-item').forEach((n) => {
      const on = n.dataset.amNav === id
      n.classList.toggle('is-on', on)
      if (on) n.setAttribute('aria-current', 'page')
      else n.removeAttribute('aria-current')
    })
    if (main) main.scrollTop = 0
  }

  // The settings preview pill follows the wave theme, length and the two switches, live.
  const preview = root.querySelector('[data-am-preview]')
  let previewWave = 0
  const pick = (attr) => root.querySelector(`[${attr}].is-on`)?.getAttribute(attr)
  const switchOn = (sync) => root.querySelector(`.am-switch[data-am-sync="${sync}"]`)?.getAttribute('aria-checked') === 'true'
  const paintPreview = () => {
    if (!preview) return
    const theme = WAVE_THEME[pick('data-am-wave')] || WAVE_THEME.rainbow
    const count = WAVE_BARS[pick('data-am-len')] || 12
    const bars = preview.querySelector('.ov-bars')
    bars.replaceChildren(
      ...Array.from({ length: count }, (_, i) => {
        const b = document.createElement('i')
        b.style.background = theme.bar(i / Math.max(1, count - 1))
        // A resting speech shape, so the preview is not flat before (or without) the animation.
        const h = 3 + Math.round(Math.abs(Math.sin(i * 1.3 + 0.5)) * 13)
        b.style.height = `${h}px`
        b.style.opacity = (0.7 + (h / 18) * 0.3).toFixed(2)
        return b
      }),
    )
    const time = preview.querySelector('.ov-time')
    time.style.color = theme.timer
    time.hidden = !switchOn('duration')
    preview.querySelector('.ov-cap').hidden = !switchOn('stream')
  }
  // The preview talks with the same synthetic voice and the app's bar algorithm as the hero.
  const animatePreview = (on) => {
    clearInterval(previewWave)
    if (!on || reduceMotion.matches || !preview) return
    let sim = null
    const t0 = performance.now()
    previewWave = setInterval(() => {
      const els = Array.from(preview.querySelectorAll('.ov-bars i'))
      if (!sim || sim.prev.length !== els.length) sim = makeWave(els.length)
      const t = (performance.now() - t0) / 1000
      const talking = t % 4 < 3.2
      const frame = talking ? 0.07 * (0.35 + 0.65 * Math.abs(Math.sin(t * Math.PI * 4.2))) * (0.85 + Math.random() * 0.3) : 0.003
      paintBars(els, stepWave(sim, synthSlices(frame, els.length), frame))
    }, 33)
  }
  const setPages = $$('[data-am-set-page]')
  const showSetPage = (id) => {
    setPages.forEach((p) => { p.hidden = p.dataset.amSetPage !== id })
    $$('[data-am-set-nav]').forEach((b) => b.classList.toggle('is-on', b.dataset.amSetNav === id))
    animatePreview(id === 'appearance')
    modal?.querySelector('.am-modal-body')?.scrollTo(0, 0)
  }
  // The gear opens the sheet on its first page, as the app does.
  const openSettings = (open) => {
    if (!modal) return
    modal.hidden = !open
    if (open) {
      showSetPage('general')
      modal.querySelector('[data-am-close]')?.focus({ preventScroll: true })
    } else {
      animatePreview(false)
    }
  }
  // The chips above the window (build.mjs appMock) jump to a page, or to a page of the settings sheet.
  document.querySelectorAll('[data-am-go]').forEach((chip) =>
    chip.addEventListener('click', () => {
      const [page, sub] = chip.dataset.amGo.split(':')
      if (page === 'settings') {
        openSettings(true)
        if (sub) showSetPage(sub)
      } else {
        openSettings(false)
        go(page)
      }
    }),
  )

  // History: search, starred filter, expand a record.
  const histSearch = root.querySelector('[data-am-hist-search]')
  const histEmpty = root.querySelector('[data-am-hist-empty]')
  let starredOnly = false
  const filterHistory = () => {
    const q = (histSearch?.value || '').trim().toLowerCase()
    let shown = 0
    $$('[data-am-hist-item]').forEach((li) => {
      const starred = li.querySelector('.am-star')?.getAttribute('aria-pressed') === 'true'
      const ok = (!q || li.textContent.toLowerCase().includes(q)) && (!starredOnly || starred)
      li.hidden = !ok
      if (ok) shown++
    })
    if (histEmpty) histEmpty.hidden = shown > 0
  }
  histSearch?.addEventListener('input', filterHistory)

  // Latency badges re-measure with a short wait, as "Test all" does in the app.
  const tone = (v) => (v >= 2000 ? 'is-slow' : v >= 900 ? 'is-mid' : 'is-fast')
  const fmtMs = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`)
  const testAll = (block) =>
    block.querySelectorAll('[data-am-ms]').forEach((el) => {
      const base = Number(el.dataset.amMs) || 600
      el.className = 'am-ms is-testing'
      el.textContent = '…'
      setTimeout(() => {
        const v = Math.round(base * (0.8 + Math.random() * 0.4))
        el.className = `am-ms ${tone(v)}`
        el.textContent = fmtMs(v)
      }, 400 + Math.random() * 1100)
    })

  root.addEventListener('click', (e) => {
    const t = e.target
    const nav = t.closest('[data-am-nav]')
    if (nav) return go(nav.dataset.amNav)
    if (t.closest('[data-am-open-settings]')) return openSettings(true)
    if (t.closest('[data-am-close]') || t === modal) return openSettings(false)

    const sw = t.closest('.am-switch')
    if (sw) {
      const next = sw.getAttribute('aria-checked') !== 'true'
      const sync = sw.dataset.amSync
        ; (sync ? $$(`.am-switch[data-am-sync="${sync}"]`) : [sw]).forEach((s) => s.setAttribute('aria-checked', String(next)))
      if (sync === 'duration' || sync === 'stream') paintPreview()
      return
    }

    const edit = t.closest('[data-am-edit]')
    if (edit) {
      const box = edit.closest('.am-preset')?.querySelector('.am-preset-edit')
      if (box) {
        box.hidden = !box.hidden
        if (!box.hidden) box.querySelector('textarea')?.focus({ preventScroll: true })
      }
      return
    }

    const seg = t.closest('[data-am-seg], [data-am-hist-tab]')
    if (seg) {
      seg.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === seg))
      if (seg.dataset.amHistTab) {
        starredOnly = seg.dataset.amHistTab === '1'
        filterHistory()
      }
      return
    }

    const star = t.closest('.am-star')
    if (star) {
      star.setAttribute('aria-pressed', String(star.getAttribute('aria-pressed') !== 'true'))
      return filterHistory()
    }

    const hist = t.closest('.am-hist-main')
    if (hist) {
      const li = hist.closest('[data-am-hist-item]')
      const open = !li.classList.contains('is-open')
      li.classList.toggle('is-open', open)
      hist.setAttribute('aria-expanded', String(open))
      return
    }

    const remove = t.closest('[data-am-hot-list] button')
    if (remove) return remove.closest('li')?.remove()

    const test = t.closest('[data-am-test]')
    if (test) return testAll(test.closest('.am-block'))

    const setNav = t.closest('[data-am-set-nav]')
    if (setNav) return showSetPage(setNav.dataset.amSetNav)

    // Diagnostics: refresh re-checks each row in turn; log tabs filter by level.
    const refresh = t.closest('[data-am-diag-refresh]')
    if (refresh && !refresh.disabled) {
      const label = refresh.querySelector('span')
      const original = label.textContent
      const rows = $$('[data-am-health] li')
      refresh.disabled = true
      label.textContent = refresh.dataset.checking
      rows.forEach((r) => r.classList.add('is-checking'))
      rows.forEach((r, i) => setTimeout(() => r.classList.remove('is-checking'), 350 + i * 220))
      setTimeout(() => {
        refresh.disabled = false
        label.textContent = original
      }, 350 + rows.length * 220)
      return
    }
    const logTab = t.closest('[data-am-log]')
    if (logTab) {
      logTab.parentElement.querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b === logTab))
      const lvl = logTab.dataset.amLog
      $$('[data-am-log-view] [data-lv]').forEach((l) => {
        l.hidden = lvl !== 'all' && l.dataset.lv !== lvl
      })
      return
    }

    // Microphone test: the level meter moves for a couple of seconds.
    const micTest = t.closest('[data-am-mic-test]')
    if (micTest && !micTest.classList.contains('is-testing')) {
      const label = micTest.querySelector('span')
      const original = label.textContent
      const meter = root.querySelector('.am-meter i')
      micTest.classList.add('is-testing')
      label.textContent = micTest.dataset.testing
      const id = setInterval(() => { if (meter) meter.style.transform = `scaleX(${(0.15 + Math.random() * 0.75).toFixed(2)})` }, 90)
      setTimeout(() => {
        clearInterval(id)
        if (meter) meter.style.transform = 'scaleX(0)'
        micTest.classList.remove('is-testing')
        label.textContent = original
      }, 2400)
      return
    }

    // Shortcut boxes: click, then press a key to rebind, as in the app (Esc keeps the old one).
    const keyBtn = t.closest('[data-am-key]')
    if (keyBtn) {
      $$('[data-am-key].is-listening').forEach((k) => k.classList.remove('is-listening'))
      keyBtn.classList.add('is-listening')
      keyBtn.dataset.old = keyBtn.textContent
      keyBtn.textContent = '…'
      return
    }

    const choice = t.closest('[data-am-choice]')
    if (choice && !t.closest('textarea')) {
      const group = choice.closest('[data-am-choices]')
      Array.from(group.children).forEach((c) => {
        const on = c === choice
        c.classList.toggle('is-on', on)
        if (c.hasAttribute('aria-pressed')) c.setAttribute('aria-pressed', String(on))
      })
      if (choice.dataset.amTheme) root.dataset.theme = choice.dataset.amTheme
      if (choice.dataset.amWave || choice.dataset.amLen) paintPreview()
      // The sidebar's status icon follows the mode, as in the app (cpu / cloud / wifi).
      if (choice.dataset.amMode) $$('[data-am-conn] [data-conn]').forEach((c) => { c.hidden = c.dataset.conn !== choice.dataset.amMode })
    }
  })

  // Editing a prompt updates the one-line summary under its name, as the app's list does.
  root.addEventListener('input', (e) => {
    const area = e.target.closest('.am-preset-edit textarea')
    if (!area) return
    const line = area.closest('.am-preset')?.querySelector('.am-preset-line')
    if (line) line.textContent = area.value.split('\n')[0]
  })

  const hotForm = root.querySelector('[data-am-hot-form]')
  hotForm?.addEventListener('submit', (e) => {
    e.preventDefault()
    const input = hotForm.querySelector('[data-am-hot-input]')
    const list = root.querySelector('[data-am-hot-list]')
    const word = (input.value || '').trim()
    if (!word || !list) return
    const li = document.createElement('li')
    li.className = 'is-new'
    const span = document.createElement('span')
    span.textContent = word
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.setAttribute('aria-label', `${list.dataset.remove || ''} ${word}`.trim())
    btn.innerHTML = list.querySelector('li button')?.innerHTML || '×'
    li.append(span, btn)
    list.prepend(li)
    input.value = ''
  })

  const keyName = (e) => {
    const parts = []
    if (e.ctrlKey) parts.push('Ctrl')
    if (e.altKey) parts.push(e.code === 'AltRight' ? (LOCALE === 'zh-CN' ? '右 Alt' : 'Right Alt') : 'Alt')
    if (e.shiftKey) parts.push('Shift')
    if (e.metaKey) parts.push('Win')
    if (!['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
    return [...new Set(parts)].join(' + ')
  }
  root.addEventListener('keydown', (e) => {
    const listening = root.querySelector('[data-am-key].is-listening')
    if (listening) {
      e.preventDefault()
      listening.textContent = e.key === 'Escape' ? listening.dataset.old : keyName(e) || listening.dataset.old
      listening.classList.remove('is-listening')
      return
    }
    if (e.key === 'Escape' && modal && !modal.hidden) openSettings(false)
  })
  paintPreview()
}

/* ── The app's cleanup-preset card (AI cleanup section) ──────────────────── */

// Behaves like PromptPresetSection.tsx: New opens a blank form, a template copies in a built-in
// prompt (the real text, embedded by build.mjs), the pencil edits a preset (built-in names are
// fixed and "Restore default" brings their prompt back), Save adds or updates the row, the trash
// removes a custom one, and the shortcut box only accepts a modifier + key combination.
function initPresetCard() {
  const root = document.querySelector('[data-pp]')
  if (!root) return
  const data = JSON.parse(root.querySelector('[data-pp-data]').textContent)
  const s = data.s
  const q = (sel) => root.querySelector(sel)
  const form = q('[data-pp-form]')
  const title = q('[data-pp-form-title]')
  const name = q('[data-pp-name]')
  const prompt = q('[data-pp-prompt]')
  const tplField = q('[data-pp-template-field]')
  const tpl = q('[data-pp-template]')
  const key = q('[data-pp-key]')
  const missing = q('[data-pp-missing]')
  const restore = q('[data-pp-restore]')
  const save = q('[data-pp-save]')
  const list = q('[data-pp-list]')
  const rowTpl = q('[data-pp-tpl]')
  const custom = new Map() // id -> { name, prompt }
  const edited = {} // built-in id -> the prompt as the visitor changed it
  const shortcuts = {} // preset id -> "Alt+4"
  let editing = null // null while creating
  let shortcut = ''
  let listening = false
  let seq = 0
  const lang = () => root.dataset.lang
  const rowOf = (id) => list.querySelector(`[data-pp-row="${CSS.escape(id)}"]`)
  const isBuiltin = (id) => Boolean(id && rowOf(id)?.hasAttribute('data-builtin'))

  const renderKey = () => {
    key.classList.toggle('is-listening', listening)
    key.textContent = ''
    if (listening) {
      const hint = document.createElement('span')
      hint.textContent = s.pressKeys
      key.append(hint)
      return
    }
    ; (shortcut ? shortcut.split('+') : [s.notSet]).forEach((part, i) => {
      if (i) {
        const plus = document.createElement('span')
        plus.className = 'pp-plus'
        plus.textContent = '+'
        key.append(plus)
      }
      const cap = document.createElement('kbd')
      cap.textContent = part
      key.append(cap)
    })
  }
  // The app explains why Save is unavailable instead of just greying it out.
  const validate = () => {
    const noName = !name.value.trim()
    const noPrompt = !prompt.value.trim()
    save.disabled = noName || noPrompt
    missing.hidden = !(noName || noPrompt)
    missing.textContent = noName && noPrompt ? s.missingBoth : noName ? s.missingName : s.missingPrompt
  }
  const open = (id) => {
    editing = id
    const builtin = isBuiltin(id)
    if (!id) {
      title.textContent = s.createTitle
      name.value = ''
      prompt.value = ''
    } else if (builtin) {
      title.textContent = s.editTitle.replace('{name}', data.names[id])
      name.value = data.names[id]
      prompt.value = edited[id] ?? data.prompts[lang()][id]
    } else {
      const preset = custom.get(id)
      title.textContent = s.editTitle.replace('{name}', preset.name)
      name.value = preset.name
      prompt.value = preset.prompt
    }
    shortcut = (id && shortcuts[id]) || ''
    listening = false
    name.disabled = builtin
    tplField.hidden = Boolean(id)
    tpl.value = ''
    restore.hidden = !builtin
    form.hidden = false
    renderKey()
    validate()
    prompt.scrollTop = 0
    if (!builtin) name.focus({ preventScroll: true })
  }
  const close = () => {
    form.hidden = true
    listening = false
    editing = null
  }
  const select = (row) =>
    list.querySelectorAll('.pp-row').forEach((r) => {
      r.classList.toggle('is-on', r === row)
      r.querySelector('.pp-pick').setAttribute('aria-pressed', String(r === row))
    })
  const setBadge = (id, value) => {
    const nameRow = rowOf(id)?.querySelector('.pp-row-name')
    if (!nameRow) return
    let badge = nameRow.querySelector('.pp-sc')
    if (!value) return void badge?.remove()
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'pp-sc'
      nameRow.append(badge)
    }
    badge.textContent = value
  }

  root.addEventListener('click', (e) => {
    const t = e.target
    if (!(t instanceof Element)) return
    const langBtn = t.closest('[data-pp-lang]')
    if (langBtn) {
      const prev = lang()
      root.dataset.lang = langBtn.dataset.ppLang
      root.querySelectorAll('[data-pp-lang]').forEach((b) => b.setAttribute('aria-checked', String(b === langBtn)))
      // A built-in being edited follows the language, as long as the visitor has not changed it.
      if (editing && isBuiltin(editing) && prompt.value === data.prompts[prev][editing]) prompt.value = data.prompts[lang()][editing]
      return
    }
    if (t.closest('[data-pp-new]')) return open(null)
    if (t.closest('[data-pp-cancel]')) return close()
    if (t.closest('[data-pp-restore]')) {
      prompt.value = data.prompts[lang()][editing]
      delete edited[editing]
      return validate()
    }
    if (t.closest('[data-pp-key]')) {
      listening = !listening
      return renderKey()
    }
    if (t.closest('[data-pp-key-clear]')) {
      shortcut = ''
      listening = false
      return renderKey()
    }
    if (t.closest('[data-pp-save]')) {
      if (save.disabled) return
      let id = editing
      if (!id) {
        id = `custom-${++seq}`
        custom.set(id, { name: name.value.trim(), prompt: prompt.value })
        const row = rowTpl.content.firstElementChild.cloneNode(true)
        row.dataset.ppRow = id
        row.querySelector('b').textContent = name.value.trim()
        list.append(row)
        select(row)
      } else if (isBuiltin(id)) {
        if (prompt.value === data.prompts[lang()][id]) delete edited[id]
        else edited[id] = prompt.value
      } else {
        custom.set(id, { name: name.value.trim(), prompt: prompt.value })
        rowOf(id).querySelector('b').textContent = name.value.trim()
      }
      // A combination belongs to one preset at a time, as in the app.
      Object.keys(shortcuts).forEach((other) => {
        if (shortcut && other !== id && shortcuts[other] === shortcut) {
          delete shortcuts[other]
          setBadge(other, '')
        }
      })
      if (shortcut) shortcuts[id] = shortcut
      else delete shortcuts[id]
      setBadge(id, shortcut)
      return close()
    }
    const row = t.closest('.pp-row')
    if (!row) return
    const id = row.dataset.ppRow
    if (t.closest('[data-pp-edit]')) return open(id)
    if (t.closest('[data-pp-delete]')) {
      const wasOn = row.classList.contains('is-on')
      custom.delete(id)
      delete shortcuts[id]
      if (editing === id) close()
      row.remove()
      if (wasOn) select(list.querySelector('.pp-row'))
      return
    }
    if (t.closest('.pp-pick')) select(row)
  })
  tpl.addEventListener('change', () => {
    if (tpl.value) prompt.value = data.prompts[lang()][tpl.value]
    prompt.scrollTop = 0
    validate()
  })
  name.addEventListener('input', validate)
  prompt.addEventListener('input', validate)
  // comboOnly: a bare key keeps listening; Esc gives up; leaving the box stops listening.
  document.addEventListener('keydown', (e) => {
    if (!listening) return
    e.preventDefault()
    if (e.key === 'Escape') {
      listening = false
      return renderKey()
    }
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean)
    if (!mods.length) return
    shortcut = [...mods, e.key.length === 1 ? e.key.toUpperCase() : e.key].join('+')
    listening = false
    renderKey()
  })
  document.addEventListener('click', (e) => {
    if (listening && !(e.target instanceof Element && e.target.closest('[data-pp-key]'))) {
      listening = false
      renderKey()
    }
  })
  validate()
}

/* ── Top nav: lift the section in view ────────────────────────────────────── */

function initScrollSpy() {
  const links = Array.from(document.querySelectorAll('.topnav [data-spy]'))
  const targets = links.map((a) => document.getElementById(a.dataset.spy)).filter(Boolean)
  if (!targets.length) return
  let queued = false
  const update = () => {
    queued = false
    // A section counts once its top has passed just under the bar and its bottom has not.
    const line = 96
    const active = targets.filter((el) => {
      const r = el.getBoundingClientRect()
      return r.top <= line && r.bottom > line
    }).pop()
    links.forEach((a) => {
      if (active && a.dataset.spy === active.id) a.setAttribute('aria-current', 'true')
      else a.removeAttribute('aria-current')
    })
  }
  window.addEventListener(
    'scroll',
    () => {
      if (queued) return
      queued = true
      requestAnimationFrame(update)
    },
    { passive: true },
  )
  update()
}

async function boot() {
  document.querySelectorAll('[data-tabs]').forEach(initTabs)
  initScrollSpy()
  initReplay()
  initTerminalCopy()
  initDemo()
  initAppMock()
  initPresetCard()
  let cfg
  try {
    cfg = await loadConfig()
  } catch (e) {
    setOffline('status.initFailed', 'demo.offline')
    console.error('Boot error:', e)
    return
  }
  const demo = cfg.web_demo || {}
  state.llmEnabled = Boolean(demo.llm_enabled)
  if (!demo.enabled) return setOffline('status.unavailable', 'demo.offline')
  // Browsers only expose the microphone on HTTPS (and localhost). On a plain-http address the
  // demo cannot work at all, so say so instead of connecting.
  if (!canRecordHere()) return setOffline('status.insecure', 'demo.insecure')
  // Connect only when the demo is about to be seen: most visitors never scroll this far, and every
  // open socket counts against the server's per-IP limits. A failed attempt is rescheduled by onclose.
  const section = document.getElementById('demo')
  const start = () => connect().catch(() => { })
  if (!section || !('IntersectionObserver' in window)) return void start()
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      io.disconnect()
      void start()
    },
    { rootMargin: '400px 0px' },
  )
  io.observe(section)
}

boot()
