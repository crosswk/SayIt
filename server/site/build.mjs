#!/usr/bin/env node
// Builds the public site from one source of copy:
//   locales/en.mjs     -> server/web/index.html
//   locales/zh-CN.mjs  -> server/web/zh/index.html
// plus robots.txt, sitemap.xml and llms.txt.
//
// Why static pages instead of the old runtime i18n: crawlers and AI assistants read the HTML as
// served. The old page shipped English markup and swapped in Chinese with JavaScript, so the
// Chinese page did not exist for search engines, and the share card was always English.
//
// Usage: node server/site/build.mjs   (no dependencies; output is committed, the server has no build step)

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import en from './locales/en.mjs'
import zh from './locales/zh-CN.mjs'
import lucide from './lucide.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.resolve(HERE, '../web')
const ORIGIN = 'https://sayitapp.site'
const REPO = 'https://github.com/crosswk/SayIt'
const RELEASES = `${REPO}/releases/latest`
const LICENSE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html'
// Bump when the page content changes meaningfully; feeds sitemap <lastmod>.
// A build date would change on every run and make the output non-reproducible.
const UPDATED = '2026-11-03'
const LOCALES = [en, zh]

// The public feedback board only exists on the deployed site (it needs a backend the public
// repository does not ship). Link to it only when the page is actually here, so self-hosters
// never get a dead link.
const HAS_FEEDBACK = fs.existsSync(path.join(WEB, 'feedback.html'))

const DOCS = {
  readme: `${REPO}#readme`,
  readmeZh: `${REPO}/blob/main/README.zh-CN.md`,
  server: `${REPO}/blob/main/server/README.md`,
  changelog: `${REPO}/blob/main/CHANGELOG.md`,
  contributing: `${REPO}/blob/main/CONTRIBUTING.md`,
  issues: `${REPO}/issues`,
  releases: `${REPO}/releases`,
  asr: `${REPO}/blob/main/docs/${encodeURIComponent('SayIt 语音识别配置.md')}`,
  ai: `${REPO}/blob/main/docs/${encodeURIComponent('SayIt AI 润色供应商配置.md')}`,
  video: 'https://www.bilibili.com/video/BV1JLTs6REPU/',
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// Copy may contain <br> for deliberate line breaks in display headings. Nothing else.
const display = (s) => esc(s).replace(/&lt;br&gt;/g, '<br>')

/* Line endings: a paragraph must never end on a line holding two or three characters
   (owner, 2026-10-13). CSS text-wrap: pretty only protects the last *word*, and in Chinese every
   character is a word, so it cannot stop "的。" from wrapping alone. Gluing the tail into one
   unbreakable run can: the last line then always carries at least that run.
   Chinese: the last clause (4–12 characters) or else the last 6 characters. English: the last two
   words, three when the last one is short. */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
const CLAUSE_END = '，、；：。！？'

const LATIN = /[A-Za-z0-9.\-+ \u00a0]/

function splitTail(raw) {
  const s = String(raw ?? '')
  if (CJK.test(s)) {
    const ch = Array.from(s)
    if (ch.length <= 3) return [s, '']
    // Short copy needs it too: a 10-character hint in a narrow card can still drop "束" alone
    // (seen in the settings mock, 2026-10-18). Keep the last four together.
    let cut = ch.length - (ch.length <= 12 ? 4 : 6)
    // Whole clauses read better than six arbitrary characters: take the last clause, or the
    // last two when the last is very short ("……另设一个键，按住说话。" keeps "一个键" together).
    for (let i = ch.length - 2; ch.length > 12 && i >= Math.max(1, ch.length - 20); i--) {
      if (!CLAUSE_END.includes(ch[i])) continue
      const len = ch.length - 1 - i
      if (len >= 6 && len <= 18) {
        cut = i + 1
        break
      }
      if (len > 18) break
    }
    // Never start the tail inside a Latin word or a number with its unit ("16 GB").
    while (cut > 0 && LATIN.test(ch[cut - 1]) && LATIN.test(ch[cut])) cut--
    if (ch[cut] === ' ') cut++
    // A line may not start with a comma or full stop; leave it on the line above.
    if (CLAUSE_END.includes(ch[cut])) cut++
    return [ch.slice(0, cut).join(''), ch.slice(cut).join('')]
  }
  const words = s.split(' ')
  if (words.length < 4) return [s, '']
  const keep = words[words.length - 1].replace(/[^\w]/g, '').length <= 4 ? 3 : 2
  return [words.slice(0, -keep).join(' ') + ' ', words.slice(-keep).join('\u00a0')]
}

const glued = (tail) => (tail ? (CJK.test(tail) ? `<span class="nb">${esc(tail)}</span>` : esc(tail)) : '')
// A number never wraps away from its unit: "16 GB", "0.8 s".
// Product names are not split either ("Claude / Code").
const units = (s) =>
  String(s ?? '')
    .replace(/(\d) (GB|MB|KB|TB|ms|s)\b/g, '$1\u00a0$2')
    .replace(/\b(Claude|Docker|Wispr) (Code|Compose|Flow)\b/g, '$1\u00a0$2')
const para = (raw) => {
  const [head, tail] = splitTail(units(raw))
  return esc(head) + glued(tail)
}

/* Headings never leave one or two characters on a line (owner, 2026-10-18: "在浏览器里试试" broke
   as "…试" / "试" in a narrow column). Chinese headings break only between clauses: each clause is
   one unbreakable run, and --hl (the longest clause, in em) lets the CSS cap the font size so that
   run always fits its column (style.css, "Headings"). English keeps its last two words together. */
const CJK_WIDE = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/
function heading(raw) {
  const s = units(raw)
  if (!CJK.test(s)) {
    const [head, tail] = splitTail(s)
    return { html: esc(head) + esc(tail), attr: '' }
  }
  const clauses = s.match(new RegExp(`[^${CLAUSE_END}]+[${CLAUSE_END}]*|[${CLAUSE_END}]+`, 'g')) || [s]
  const em = (c) => Array.from(c).reduce((n, x) => n + (CJK_WIDE.test(x) ? 1 : 0.56), 0)
  const longest = Math.max(...clauses.map(em))
  return {
    html: clauses.map((c) => `<span class="hc">${esc(c)}</span>`).join(''),
    attr: ` style="--hl:${longest.toFixed(2)}"`,
  }
}
// <h2 id="x">…</h2> with the heading treatment.
const hx = (tag, raw, attrs = '') => {
  const h = heading(raw)
  return `<${tag}${attrs}${h.attr}>${h.html}</${tag}>`
}

// ~~removed~~ and {{misheard}} markers -> <del> / <del class="misheard">
function speech(s) {
  const parts = String(s).split(/(~~[^~]+~~|\{\{[^}]+\}\})/).filter(Boolean)
  const html = parts.map((part, i) => {
    if (part.startsWith('~~')) return `<del>${esc(part.slice(2, -2))}</del>`
    if (part.startsWith('{{')) return `<del class="misheard">${esc(part.slice(2, -2))}</del>`
    // Glue the end of the sentence so a struck-through phrase never leaves "的。" alone below it.
    if (i === parts.length - 1) {
      const ch = Array.from(part)
      if (CJK.test(part) && ch.length > 6) return esc(ch.slice(0, -6).join('')) + glued(ch.slice(-6).join(''))
      if (CJK.test(part)) return glued(part)
      return para(part)
    }
    return esc(part)
  })
  // A sentence ending in a struck phrase ("…, ~~you know~~.") must not leave "know." alone on the
  // last line: keep that phrase and its full stop together.
  const n = parts.length
  if (n >= 2 && Array.from(parts[n - 1]).length <= 2 && /^(~~|\{\{)/.test(parts[n - 2])) {
    html.splice(n - 2, 2, `<span class="nb">${html[n - 2]}${esc(parts[n - 1])}</span>`)
  }
  return html.join('')
}

/* The overlay's default waveform theme, "black-rainbow" (client/src/overlay/Overlay.tsx,
   getListeningBarColor): hue 140 -> 30 across the bars, a little lighter in the middle.
   The site draws the same bars so the page and the app share one colour signature. */
const barColor = (i, n) => {
  const t = i / Math.max(1, n - 1)
  return `hsl(${140 - Math.round(t * 110)} 95% ${64 - Math.round(Math.abs(t - 0.5) * 12)}%)`
}
// A spoken phrase, not a sine: uneven peaks, quieter at both ends.
const SPEECH_ENV = [0.22, 0.38, 0.6, 0.45, 0.78, 0.92, 0.6, 1, 0.82, 0.55, 0.7, 0.96, 0.66, 0.86, 0.5, 0.72, 0.9, 0.62, 0.42, 0.56, 0.36, 0.48, 0.3, 0.2]

/* The overlay exactly as the app draws it (client/src/overlay/Overlay.tsx + index.css), at 1:1 px:
   #0b0b0c surface with a 10% white hairline and no shadow; the "short" length (12 bars, the owner's
   choice for the site) of 2.5px, 2px apart, 3-18px tall, opacity 0.7 + h/18*0.3; the timer is "7s"
   in #fef08a. The owner asked for every overlay on the site to match the real one (2026-10-13),
   so do not restyle these: change the app first, then copy the change here. */
const OVERLAY_BARS = 12
// One frame of real speech as the app draws it (services/waveform.ts): every bar is the RMS of a
// slice of the same audio frame, so they sit around one level with uneven tops, centre a touch
// taller. Not a designed curve with quiet ends.
const FRAME = [0.62, 0.86, 0.55, 0.95, 0.74, 0.9, 1, 0.7, 0.88, 0.58, 0.8, 0.6]
function ovBars(n = OVERLAY_BARS, quiet = false) {
  return Array.from({ length: n }, (_, i) => {
    const centre = Math.max(0.7, 1 - (Math.abs(i - (n - 1) / 2) / Math.max(1, (n - 1) / 2)) * 0.15)
    const h = quiet ? 3 : Math.max(3, Math.round(FRAME[i % FRAME.length] * 18 * centre))
    return `<i style="height:${h}px;opacity:${(0.7 + (h / 18) * 0.3).toFixed(2)};background:${barColor(i, n)}"></i>`
  }).join('')
}
function ovPill(t, { secs = 0, quiet = false, attrs = '', barsId = '', timerId = '', think = true } = {}) {
  return `<div class="ov-pill"${attrs}><span class="ov-surface"></span><span class="ov-stage"><span class="ov-dots"><i></i><i></i><i></i></span><span class="ov-rec"><span class="ov-bars"${barsId ? ` id="${barsId}"` : ''}>${ovBars(OVERLAY_BARS, quiet)}</span><span class="ov-time"${timerId ? ` id="${timerId}"` : ' data-timer'}>${secs}s</span></span>${think ? `<span class="ov-think"><span class="ov-track"><i></i></span><span>${esc(t.overlay.processing)}</span></span>` : ''}</span></div>`
}
// The live-caption bubble: label, up to three lines bottom-aligned, caret, a 7px tail to the pill.
function ovCaption(t, text, attrs = '') {
  return `<div class="ov-cap"${attrs}><span class="ov-cap-label">${esc(t.overlay.live)}</span><div class="ov-cap-body"><div><span data-cap-text>${esc(text)}</span><i class="ov-caret"></i></div></div></div>`
}

function fileHash(rel) {
  const p = path.join(WEB, rel)
  if (!fs.existsSync(p)) return '0'
  return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 8)
}

const jsonLd = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c')

/* ── icons (24px grid, 1.6 stroke, round joins: one family) ──────────────── */

const svg = (body, { size = 20, fill = false, cls = '' } = {}) =>
  `<svg class="ico${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"${fill ? ' fill="currentColor"' : ' fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
  }>${body}</svg>`

const I = {
  windows: (o) => svg('<path d="M3 5.2 10.4 4.2v7.1H3zM11.6 4 21 2.7v8.6h-9.4zM3 12.7h7.4v7.1L3 18.8zM11.6 12.7H21v8.6l-9.4-1.3z"/>', { fill: true, ...o }),
  // Simple Icons "apple" (CC0), filled like the Windows mark beside it.
  apple: (o) =>
    svg(
      '<path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>',
      { fill: true, ...o },
    ),
  github: (o) =>
    svg(
      '<path d="M12 1.8a10.2 10.2 0 0 0-3.2 19.9c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.4 1.1 3 .8.1-.7.4-1.1.7-1.4-2.3-.3-4.6-1.1-4.6-5a3.9 3.9 0 0 1 1-2.7c-.1-.3-.5-1.3.1-2.7 0 0 .9-.3 2.8 1a9.6 9.6 0 0 1 5.1 0c1.9-1.3 2.8-1 2.8-1 .6 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.3 4.8-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10.2 10.2 0 0 0 12 1.8z"/>',
      { fill: true, ...o },
    ),
  download: (o) => svg('<path d="M12 3.5v11"/><path d="m7.5 10 4.5 4.5 4.5-4.5"/><path d="M4.5 19.5h15"/>', o),
  mic: (o) => svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>', o),
  stop: (o) => svg('<rect x="6.5" y="6.5" width="11" height="11" rx="2.2"/>', { fill: true, ...o }),
  play: (o) => svg('<path d="M8 5.6v12.8a.8.8 0 0 0 1.2.7l10-6.4a.8.8 0 0 0 0-1.4l-10-6.4A.8.8 0 0 0 8 5.6z"/>', { fill: true, ...o }),
  pause: (o) => svg('<rect x="6.5" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.9" y="5" width="3.6" height="14" rx="1.2"/>', { fill: true, ...o }),
  copy: (o) => svg('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>', o),
  check: (o) => svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', o),
  replay: (o) => svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.7h3.7"/>', o),
  chevron: (o) => svg('<path d="m7 9.5 5 5 5-5"/>', o),
  arrow: (o) => svg('<path d="M4.5 12h15"/><path d="m14 6.5 5.5 5.5-5.5 5.5"/>', o),
  pc: (o) => svg('<rect x="3" y="4" width="18" height="12" rx="1.8"/><path d="M9 20h6"/><path d="M12 16v4"/>', o),
  cloud: (o) => svg('<path d="M7.5 18.5h9.8a4.2 4.2 0 0 0 .6-8.4 6 6 0 0 0-11.6 1.3 3.6 3.6 0 0 0 1.2 7.1z"/>', o),
  server: (o) => svg('<rect x="4" y="3.5" width="16" height="7" rx="1.6"/><rect x="4" y="13.5" width="16" height="7" rx="1.6"/><path d="M8 7h.01M8 17h.01"/>', o),
  cursor: (o) => svg('<path d="M9 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H9"/><path d="M15 4h-2a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h2"/><path d="M10 12h4"/>', o),
  wave: (o) => svg('<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>', o),
  sparkle: (o) => svg('<path d="M12 3.5 13.7 9a1.5 1.5 0 0 0 1 1l5.3 1.7-5.3 1.7a1.5 1.5 0 0 0-1 1L12 20l-1.7-5.6a1.5 1.5 0 0 0-1-1L4 11.7 9.3 10a1.5 1.5 0 0 0 1-1z"/>', o),
  plug: (o) => svg('<path d="M9 3.5v4M15 3.5v4"/><path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z"/><path d="M12 16v4.5"/>', o),
  clock: (o) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', o),
  brush: (o) => svg('<path d="M14.5 4.5 19.5 9.5 11 18l-5-5z"/><path d="M6 13c-2 .5-2.5 2.5-2.5 6.5 4 0 6-.5 6.5-2.5"/>', o),
  terminal: (o) => svg('<path d="m6 8.5 4 3.5-4 3.5"/><path d="M12.5 16h5.5"/>', o),
  // The app's own sidebar and toolbar icons (lucide), redrawn on the same grid.
  home: (o) => svg('<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>', o),
  book: (o) => svg('<path d="M12 6.5C10.5 5 8.3 4.5 4 4.5v13c4.3 0 6.5.5 8 2 1.5-1.5 3.7-2 8-2v-13c-4.3 0-6.5.5-8 2z"/><path d="M12 6.5v13"/>', o),
  wand: (o) => svg('<path d="m4 20 11-11"/><path d="m13.5 7.5 3 3"/><path d="M18 3v3M16.5 4.5h3M20 9v2M19 10h2M9 3v2M8 4h2"/>', o),
  gear: (o) => svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>', o),
  info: (o) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>', o),
  wifi: (o) => svg('<path d="M2.5 9a14 14 0 0 1 19 0"/><path d="M5.5 12.5a9.5 9.5 0 0 1 13 0"/><path d="M8.7 16a5 5 0 0 1 6.6 0"/><path d="M12 19.5h.01"/>', o),
  search: (o) => svg('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>', o),
  star: (o) => svg('<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>', o),
  chevronUp: (o) => svg('<path d="m7 14.5 5-5 5 5"/>', o),
  trash: (o) => svg('<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5h9l1-12.5"/>', o),
  edit: (o) => svg('<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"/>', o),
  checkCircle: (o) => svg('<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/>', o),
  x: (o) => svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', o),
  cpu: (o) => svg('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21"/>', o),
  zap: (o) => svg('<path d="M13 3 5 13.5h6L10.5 21 19 10h-6z"/>', o),
  type: (o) => svg('<path d="M5 7V5h14v2"/><path d="M12 5v14"/><path d="M9 19h6"/>', o),
  plus: (o) => svg('<path d="M12 6v12M6 12h12"/>', o),
}

// The app's own icons, copied from the lucide-react it ships (lucide.mjs, generated). Use these for
// anything that depicts the app, so it matches 1:1 (owner, 2026-10-13: a hand-drawn gear read as a sun).
function L(name, size = 16, cls = '') {
  if (!lucide[name]) throw new Error(`lucide icon missing: ${name} (add it to the generator)`)
  return `<svg class="ico${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${lucide[name]}</svg>`
}

// Fluent caption buttons are drawn at 10px. The site never pretends they work.
const caps = `<span class="win-caps" aria-hidden="true"><i class="cap-min"></i><i class="cap-max"></i><i class="cap-close"></i></span>`

/* ── sections ────────────────────────────────────────────────────────────── */

/* The nav is the app's TabsList in a pill, centred, with the section in view lifted onto white
   (app.js marks it). Names follow the app's own terms; "three modes" and "prompts" read oddly
   (owner, 2026-10-16). */
function header(t) {
  const n = t.nav
  const links = [
    ['#rules', n.rules],
    ['#self-host', n.selfhost],
    ['#models', n.models],
    ['#app', n.app],
    ['#faq', n.faq],
  ]
    .map(([href, label]) => `<a href="${href}" data-spy="${href.slice(1)}">${esc(label)}</a>`)
    .join('')
  const feedback = HAS_FEEDBACK ? `<a href="/feedback.html">${esc(n.feedback)}</a>` : ''
  return `<header class="topbar">
  <div class="topbar-inner wrap">
    <a class="brand" href="${t.path}" aria-label="${esc(n.home)}"><img src="/logo-72.png" width="28" height="28" alt=""><span>SayIt</span></a>
    <nav class="topnav" aria-label="${esc(n.label)}">${links}${feedback}</nav>
    <div class="topbar-actions">
      <a class="ime" href="${n.switchTo.href}" hreflang="${n.switchTo.hreflang}" lang="${n.switchTo.hreflang}" title="${esc(n.switchTo.title)}">${esc(n.switchTo.label)}</a>
      <a class="icon-btn topbar-gh" href="${REPO}" rel="noopener" aria-label="${esc(n.github)}">${I.github({ size: 18 })}</a>
      <a class="btn btn-accent topbar-dl" href="${RELEASES}" data-download aria-label="${esc(n.downloadLabel)}"><span class="dl-logos">${I.windows({ size: 14 })}${I.apple({ size: 14 })}</span><span>${esc(n.download)}</span></a>
    </div>
  </div>
</header>`
}

/* First viewport: dictating to AI coding tools, the case most SayIt users bought it for
   (.kiro/design/positioning.md). Each tool drawn the way it really looks: Claude Code and Codex as
   TUIs in a dark Windows Terminal, Kiro as its IDE with the chat panel. The app's overlay at 1:1
   sits below the window, as it does at the bottom of a real screen.
   No frame, no wallpaper, no keycap, no glow: the owner rejected each of those.
   The caption shows the raw transcript (the app's live caption is the raw text); the clean prompt
   appears in the input box all at once, because the app pastes, it does not type.
   The HTML is the finished frame of tab 1 (crawlers, no JS, reduced motion); app.js replays it. */
/* The tools' own interface text. It is English in their real UIs, so it is not localized here;
   only the conversation inside comes from the locale. Drawn after the real apps (Claude Code 2.x
   in Windows Terminal, the Codex desktop app, Kiro IDE) without their logos.
   Codex is its desktop app, not the CLI (owner, 2026-10-16): projects and threads on the left, the
   thread in the middle, the composer with model and reasoning pickers, Local / branch underneath.
   The model is Codex's current default (GPT-6.1 Sol since 2026-09-29; owner, 2026-10-19: 5.3-Codex
   was outdated). Update it when Codex changes its default, or the mock looks old. */
const TOOL_UI = {
  claude: { welcome: 'Welcome to Claude Code!', help: '/help for help, /status for your current setup', footer: '? for shortcuts', mode: '⏵⏵ accept edits on (shift+tab to cycle)' },
  codex: { app: 'Codex', newThread: 'New thread', automations: 'Automations', skills: 'Skills', threads: 'Threads', settings: 'Settings', open: 'Open', commit: 'Commit', placeholder: 'Ask Codex anything, @ to add files, / for commands', model: 'GPT-6.1 Sol', effort: 'Medium', local: 'Local', branch: 'main' },
  kiro: { placeholder: 'Ask a question or describe a task...', autopilot: 'Autopilot', model: 'Claude Sonnet 5.5', vibe: 'Vibe', spec: 'Spec' },
}

// Windows Terminal (dark, Campbell) around a TUI.
const wtWindow = (title, body) => `<div class="wt">
          <div class="wt-bar"><span class="wt-tab">${I.terminal({ size: 13 })}<span>${esc(title)}</span><i class="wt-tab-x"></i></span><span class="wt-new" aria-hidden="true">${I.plus({ size: 13 })}</span><span class="wt-drop" aria-hidden="true">${I.chevron({ size: 12 })}</span>${caps}</div>
          <div class="wt-body">${body}</div>
        </div>`

function claudePane(tab) {
  const u = TOOL_UI.claude
  const hist = tab.history
    .map(([kind, a, b]) =>
      kind === 'user'
        ? `<p class="cc-user"><span class="cc-gt">&gt;</span> ${esc(a)}</p>`
        : kind === 'tool'
          ? `<p class="cc-msg"><span class="cc-dot is-ok">●</span><span><b>${esc(a.split('(')[0])}</b>(${esc(a.slice(a.indexOf('(') + 1, -1))})</span></p><p class="cc-out"><span class="cc-elbow">⎿</span>  ${esc(b)}</p>`
          : `<p class="cc-msg"><span class="cc-dot">●</span><span>${esc(a)}</span></p>`,
    )
    .join('')
  return wtWindow(
    tab.title,
    `<div class="cc">
            <div class="cc-welcome"><p><span class="cc-star">✻</span> ${esc(u.welcome)}</p><p class="cc-dim">  ${esc(u.help)}</p><p class="cc-dim">  cwd: ${esc(tab.cwd)}</p></div>
            ${hist}
            <div class="cc-input"><span class="cc-gt">&gt;</span><p class="t-typed" data-typed>${esc(tab.typed)}</p></div>
            <p class="cc-foot"><span>${esc(u.footer)}</span><span class="cc-mode">${esc(u.mode)}</span></p>
          </div>`,
  )
}

// The Codex desktop app, light theme: sidebar of projects and threads, the open thread, the composer.
function codexPane(tab) {
  const u = TOOL_UI.codex
  const side = tab.threads
    .map(
      ([project, threads]) =>
        `<p class="cxa-proj">${L('folder', 14)}<span>${esc(project)}</span></p>${threads
          .map(([title, when]) => `<p class="cxa-thr${title === tab.thread ? ' is-on' : ''}"><span>${esc(title)}</span><small>${esc(when)}</small></p>`)
          .join('')}`,
    )
    .join('')
  const hist = tab.history
    .map(([kind, a, b]) =>
      kind === 'user'
        ? `<p class="cxa-user">${esc(a)}</p>`
        : kind === 'tool'
          ? `<p class="cxa-work">${L('chevronRight', 13)}<b>${esc(a)}</b><span>${esc(b)}</span></p>`
          : `<p class="cxa-msg">${esc(a)}</p>`,
    )
    .join('')
  return `<div class="cxa">
          <div class="cxa-bar"><span class="cxa-title">${esc(u.app)}</span>${caps}</div>
          <div class="cxa-body">
            <aside class="cxa-side" aria-hidden="true">
              <p class="cxa-nav">${L('squarePen', 14)}<span>${esc(u.newThread)}</span></p>
              <p class="cxa-nav">${L('clock', 14)}<span>${esc(u.automations)}</span></p>
              <p class="cxa-nav">${L('blocks', 14)}<span>${esc(u.skills)}</span></p>
              <p class="cxa-h">${esc(u.threads)}</p>
              ${side}
              <p class="cxa-nav cxa-side-foot">${L('settings', 14)}<span>${esc(u.settings)}</span></p>
            </aside>
            <div class="cxa-main">
              <p class="cxa-head"><b>${esc(tab.thread)}</b><span class="cxa-btn">${esc(u.open)}${L('chevronDown', 12)}</span><span class="cxa-btn is-dark">${esc(u.commit)}</span></p>
              <div class="cxa-thread">${hist}</div>
              <div class="cxa-composer">
                <p class="t-typed" data-typed data-placeholder="${esc(u.placeholder)}">${esc(tab.typed)}</p>
                <p class="cxa-tools">${L('plus', 15)}<span class="cxa-pick">${esc(u.model)}${L('chevronDown', 12)}</span><span class="cxa-pick">${esc(u.effort)}${L('chevronDown', 12)}</span><span class="cxa-mic">${L('mic', 15)}</span><span class="cxa-send">${L('arrowUp', 14)}</span></p>
              </div>
              <p class="cxa-under"><span>${L('laptop', 13)}${esc(u.local)}${L('chevronDown', 11)}</span><span>${L('gitBranch', 13)}${esc(u.branch)}${L('chevronDown', 11)}</span></p>
            </div>
          </div>
        </div>`
}

// Kiro is an IDE, not a terminal: editor on the left, the chat panel on the right.
function kiroPane(tab) {
  const u = TOOL_UI.kiro
  const doc = tab.doc
    .map((line, i) => `<p><span class="kr-ln">${i + 1}</span><span class="${line.startsWith('#') ? 'kr-h' : line.startsWith('-') ? 'kr-li' : ''}">${esc(line)}</span></p>`)
    .join('')
  const chat = tab.history
    .map(([kind, a]) =>
      kind === 'user'
        ? `<p class="kr-user">${esc(a)}</p>`
        : kind === 'files'
          ? `<p class="kr-files">${a.map((f) => `<span>${esc(f)}</span>`).join('')}</p>`
          : `<p class="kr-msg">${esc(a)}</p>`,
    )
    .join('')
  return `<div class="kr">
          <div class="kr-bar"><span class="kr-menu">File  Edit  Selection  View</span><span class="kr-title">${esc(tab.project)} - Kiro</span>${caps}</div>
          <div class="kr-body">
            <div class="kr-act" aria-hidden="true">${['files', 'search', 'gitBranch', 'blocks'].map((n, i) => `<span${i === 0 ? ' class="is-on"' : ''}>${L(n, 20)}</span>`).join('')}</div>
            <div class="kr-editor"><p class="kr-tab">${esc(tab.file)}</p><div class="kr-doc">${doc}</div></div>
            <div class="kr-chat">
              <p class="kr-chat-head"><span>${esc(tab.session)}</span><span class="kr-modes"><b>${esc(u.vibe)}</b><span>${esc(u.spec)}</span></span></p>
              <div class="kr-thread">${chat}</div>
              <div class="kr-input">
                <p class="t-typed" data-typed data-placeholder="${esc(u.placeholder)}">${esc(tab.typed)}</p>
                <p class="kr-input-foot"><span class="kr-auto"><i></i>${esc(u.autopilot)}</span><span class="kr-model">${esc(u.model)} ${I.chevron({ size: 11 })}</span><span class="kr-send">${I.arrow({ size: 13 })}</span></p>
              </div>
            </div>
          </div>
        </div>`
}

const toolPane = (tab) => (tab.app === 'kiro' ? kiroPane(tab) : tab.app === 'codex' ? codexPane(tab) : claudePane(tab))

function hero(t) {
  const h = t.hero
  const s = h.stage
  const tabs = s.tabs
    .map(
      (tab, i) =>
        `<button type="button" role="tab" id="hero-tab-${i}" aria-controls="hero-pane-${i}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-secs="${tab.secs}" data-said="${esc(tab.said)}"><span>${esc(tab.name)}</span></button>`,
    )
    .join('')
  const panes = s.tabs
    .map((tab, i) => `<div class="tool-pane tool-${tab.app}" role="tabpanel" id="hero-pane-${i}" aria-labelledby="hero-tab-${i}"${i ? ' hidden' : ''}>
        ${toolPane(tab)}
      </div>`)
    .join('\n      ')
  return `<section class="hero" aria-labelledby="hero-title">
  <div class="hero-inner wrap">
    <div class="hero-copy">
      <h1 id="hero-title">${display(h.title)}</h1>
      <p class="hero-lead">${para(h.lead)}</p>
      <div class="hero-actions">
        ${downloadButtons(t)}
      </div>
      <p class="hero-alt">${esc(h.macNote)}<span aria-hidden="true">·</span><a href="#demo">${I.mic({ size: 15 })}<span>${esc(h.cta2)}</span></a></p>
      <ul class="hero-facts">${h.facts.map((f) => `<li>${I.check({ size: 16 })}<span>${esc(f)}</span></li>`).join('')}</ul>
    </div>
    <figure class="stage" data-replay data-state="summary" aria-labelledby="stage-label">
      <figcaption id="stage-label" class="sr-only">${esc(s.label)}</figcaption>
      <div class="stage-top">
        <div class="switcher" role="tablist" aria-label="${esc(s.switchLabel)}">${tabs}</div>
      </div>
      <div class="tool-panes">
      ${panes}
      </div>
      <div class="ov" aria-hidden="true">
        ${ovCaption(t, s.tabs[0].said)}
        ${ovPill(t, { secs: s.tabs[0].secs })}
      </div>
    </figure>
  </div>
</section>`
}

/* All examples at once, no tabs: the owner found clicking through "filler words / corrections /
   lists" both indirect and robotic. The strike-throughs carry the explanation, so no labels. */
/* Three before/after cards side by side under a centred heading (owner, 2026-10-19: the full-width
   left-aligned rows were passable but plain). Each card reads top to bottom: what you said, an arrow,
   what got typed. The cards share their row heights (CSS subgrid), so the arrows line up. */
function cleanup(t) {
  const c = t.cleanup
  const rows = c.examples
    .map(
      (e) => `<li class="pair">
          <div class="pair-said"><p class="pair-label">${I.mic({ size: 13 })}${esc(c.said)}</p><p>${speech(e.said)}</p></div>
          <span class="pair-arrow" aria-hidden="true">${I.arrow({ size: 16 })}</span>
          <div class="pair-typed"><p class="pair-label">${I.sparkle({ size: 13 })}${esc(c.typed)}</p><p>${para(e.typed)}</p></div>
        </li>`,
    )
    .join('\n        ')
  return `<section class="section" id="cleanup" aria-labelledby="cleanup-title">
  <div class="wrap">
    <header class="section-head is-center">
      ${hx('h2', c.title, ' id="cleanup-title"')}
      <p>${para(c.lead)}</p>
    </header>
    <ol class="pairs-list">
        ${rows}
    </ol>
    <p class="note is-center">${para(c.note)}</p>
  </div>
</section>`
}

/* The app's built-in prompts, read from the client source, so the preset card's template picker and
   its "edit" show the real text and follow the app when it changes them. */
function builtinPrompts() {
  const dir = path.resolve(HERE, '../../client/src/services')
  const zhSrc = fs.readFileSync(path.join(dir, 'store.ts'), 'utf8')
  const start = zhSrc.indexOf('export const BUILTIN_PRESETS')
  const zhBlock = zhSrc.slice(start, zhSrc.indexOf('// i18n-allow-end', start))
  const enSrc = fs.readFileSync(path.join(dir, 'builtinPromptsEn.ts'), 'utf8')
  const out = { 'zh-CN': {}, en: {} }
  for (const m of zhBlock.matchAll(/id: '(\w+)',[\s\S]*?systemPrompt: `([^`]*)`/g)) out['zh-CN'][m[1]] = m[2]
  for (const m of enSrc.matchAll(/^ {2}(\w+): `([^`]*)`/gm)) out.en[m[1]] = m[2]
  for (const lang of Object.keys(out)) {
    for (const id of ['intent', 'faithful', 'zh2en', 'casual']) {
      if (!out[lang][id] || out[lang][id].includes('${')) throw new Error(`built-in prompt ${lang}/${id} not found in client/src/services`)
    }
  }
  return out
}
const BUILTIN_PROMPTS = builtinPrompts()

const logoImg = (id, size = 24) =>
  id === 'plug' ? L('plug', size) : id === 'notepad' ? L('notepadText', size) : `<img src="/img/logos/${id}.svg" width="${size}" height="${size}" alt="" loading="lazy" decoding="async">`

/* The core selling point (owner, 2026-10-13): the prompt is entirely yours.
   Left of the fold, the app's own "cleanup presets" card (PromptPresetSection.tsx) with its
   new-preset form open, field for field. The owner caught the previous version inventing two
   fields the app does not have (2026-10-16), so nothing here goes beyond the real card; app.js
   makes it behave like the real one (template, edit, save, delete, shortcut).
   Below: one sentence through four presets, laid out as one input fanning out to four results,
   then the per-app rules as the apps' own icons. */
function rules(t) {
  const r = t.rules
  const c = r.card
  const rows = c.presets
    .map(
      ([id, name, desc], i) => `<li class="pp-row${i === 0 ? ' is-on' : ''}" data-pp-row="${id}" data-builtin>
            <button type="button" class="pp-pick" aria-pressed="${i === 0}"><span class="pp-radio" aria-hidden="true"></span><span class="pp-row-main"><span class="pp-row-name"><b>${esc(name)}</b><span class="pp-badge">${esc(c.builtin)}</span></span><small>${para(desc)}</small></span></button>
            <span class="pp-row-acts"><button type="button" class="pp-icon" data-pp-edit aria-label="${esc(c.edit)}">${L('pencil', 14)}</button></span>
          </li>`,
    )
    .join('\n          ')
  const options = [`<option value="">${esc(c.noTemplate)}</option>`, ...c.presets.map(([id, name]) => `<option value="${id}">${esc(c.builtinSuffix.replace('{name}', name))}</option>`)].join('')
  const data = {
    prompts: BUILTIN_PROMPTS,
    names: Object.fromEntries(c.presets.map(([id, name]) => [id, name])),
    s: { createTitle: c.createTitle, editTitle: c.editTitle, missingBoth: c.missingBoth, missingName: c.missingName, missingPrompt: c.missingPrompt, notSet: c.notSet, pressKeys: c.pressKeys, builtin: c.builtin, edit: c.edit, delete: c.delete, draftName: c.draftName, draftPrompt: c.draftPrompt },
  }
  const card = `<div class="pp" data-pp data-lang="${c.lang}">
        <script type="application/json" data-pp-data>${jsonLd(data)}</script>
        <div class="pp-head">
          <p class="pp-title"><b>${esc(c.title)}</b><span class="pp-info" title="${esc(c.desc)}" aria-label="${esc(c.desc)}">${L('info', 14)}</span></p>
          <div class="pp-head-acts">
            <span class="pp-seg" role="radiogroup" aria-label="${esc(c.langLabel)}">${c.langs.map(([id, label]) => `<button type="button" role="radio" aria-checked="${id === c.lang}" data-pp-lang="${id}">${esc(label)}</button>`).join('')}</span>
            <button type="button" class="pp-new" data-pp-new>${L('plus', 12)}<span>${esc(c.new)}</span></button>
          </div>
        </div>
        <div class="pp-form" data-pp-form>
          <p class="pp-form-title" data-pp-form-title>${esc(c.createTitle)}</p>
          <label class="pp-field"><span class="pp-label">${esc(c.name)}</span><input class="pp-input" type="text" data-pp-name value="${esc(c.draftName)}" placeholder="${esc(c.namePlaceholder)}" maxlength="40"></label>
          <div class="pp-field" data-pp-template-field><label class="pp-label" for="pp-template-${t.lang}">${esc(c.template)}</label><span class="pp-select"><select id="pp-template-${t.lang}" data-pp-template>${options}</select>${L('chevronDown', 16)}</span><p class="pp-hint">${para(c.templateHint)}</p></div>
          <label class="pp-field"><span class="pp-label">${esc(c.systemPrompt)}</span><span class="pp-hint pp-hint-top">${para(c.systemPromptHint)}</span><textarea class="pp-textarea" data-pp-prompt rows="8" spellcheck="false" placeholder="${esc(c.systemPromptPlaceholder)}">${esc(c.draftPrompt)}</textarea></label>
          <div class="pp-shortcut"><span><b>${esc(c.shortcut)}</b><small>${para(c.shortcutHint)}</small></span><span class="pp-key-wrap"><button type="button" class="pp-key" data-pp-key><kbd>${esc(c.notSet)}</kbd></button><button type="button" class="pp-icon" data-pp-key-clear aria-label="${esc(c.clear)}">${L('x', 14)}</button></span></div>
          <div class="pp-foot"><span class="pp-missing" data-pp-missing hidden></span><button type="button" class="pp-link" data-pp-restore hidden>${esc(c.restoreDefault)}</button><button type="button" class="pp-btn" data-pp-cancel>${esc(c.cancel)}</button><button type="button" class="pp-btn is-primary" data-pp-save>${esc(c.save)}</button></div>
        </div>
        <ul class="pp-list" data-pp-list>
          ${rows}
        </ul>
        <template data-pp-tpl><li class="pp-row is-new" data-pp-row=""><button type="button" class="pp-pick" aria-pressed="false"><span class="pp-radio" aria-hidden="true"></span><span class="pp-row-main"><span class="pp-row-name"><b></b></span></span></button><span class="pp-row-acts"><button type="button" class="pp-icon" data-pp-edit aria-label="${esc(c.edit)}">${L('pencil', 14)}</button><button type="button" class="pp-icon is-danger" data-pp-delete aria-label="${esc(c.delete)}">${L('trash2', 14)}</button></span></li></template>
      </div>`
  const fan = r.cards
    .map(
      (it) => `<li class="fan-row${it.kind === 'custom' ? ' is-custom' : ''}">
          <div class="fan-mode"><p><b>${esc(it.name)}</b><span class="fan-badge">${esc(it.kind === 'custom' ? r.custom : r.builtin)}</span></p><small>${para(it.desc)}</small></div>
          <p class="fan-out${it.mono ? ' is-mono' : ''}"><span>${para(it.output)}</span></p>
        </li>`,
    )
    .join('\n        ')
  const ar = r.appRules
  const apps = ar.apps
    .map(([id, label]) => `<li><span class="logo-tile">${logoImg(id, 26)}</span><span>${esc(label)}</span></li>`)
    .join('')
  return `<section class="section section-mica" id="rules" aria-labelledby="rules-title">
  <div class="wrap">
    <div class="split split-rules">
      <div class="split-copy">
        ${hx('h2', r.title, ' id="rules-title"')}
        <p>${para(r.lead)}</p>
        <ul class="team-points">${r.points.map((x) => `<li>${I.check({ size: 16 })}<span>${para(x)}</span></li>`).join('')}</ul>
      </div>
      ${card}
    </div>
    <header class="rules-head">${hx('h3', r.compareTitle, ' class="rules-sub"')}<p>${para(r.compareLead)}</p></header>
    <div class="fan">
      <div class="fan-said"><p class="fan-label">${I.mic({ size: 14 })}${esc(r.inputLabel)}</p><p class="fan-text">${para(r.input)}</p></div>
      <ol class="fan-list">
        ${fan}
      </ol>
    </div>
    <div class="apprules">
      <div class="apprules-copy"><p class="apprules-title">${esc(ar.title)}</p><p>${para(ar.desc)}</p></div>
      <ul class="apprules-apps">${apps}<li class="is-add"><span class="logo-tile">${L('plus', 18)}</span><span>${esc(ar.add)}</span></li></ul>
    </div>
  </div>
</section>`
}

/* Where speech is recognized, and with which models: one section (owner, 2026-10-18: the three
   cards with a four-row table each, and a separate model list below them, said the same thing twice
   without showing it). What the visitor decides is where the audio goes, so each card leads with who
   it is for and a small route picture: does the line leave "your PC", and where to. Then cost and
   setup in one line each, then that mode's models as logos. AI cleanup models, which apply to every
   mode, sit in one strip underneath. */
function modes(t) {
  const m = t.modes
  const icon = { local: 'cpu', cloud: 'cloud', server: 'server' }
  const flow = `<svg class="route-wire" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><path d="M0 5 H100" class="lan-wire"/><path d="M0 5 H100" class="lan-flow"/></svg>`
  const node = (ico, label, cls = '') => `<span class="route-node${cls}"><span class="route-ico">${L(ico, 18)}</span><small>${esc(label)}</small></span>`
  const route = (it) => {
    const mic = node('mic', m.speak)
    // Local: everything stays inside the PC box. Cloud / server: the line leaves it.
    if (it.id === 'local') return `<div class="route is-local"><span class="route-pc"><span class="route-pc-label">${L('laptop', 13)}${esc(m.pc)}</span>${mic}${flow}${node('cpu', it.dest, ' is-dest')}</span></div>`
    return `<div class="route"><span class="route-pc"><span class="route-pc-label">${L('laptop', 13)}${esc(m.pc)}</span>${mic}</span>${flow}${node(icon[it.id], it.dest, ' is-dest is-out')}</div>`
  }
  const models = (it) =>
    it.models
      ? `<ul class="mode-models">${it.models.map(([logo, name]) => `<li><span class="mode-logo">${logoImg(logo, 18)}</span>${esc(name)}</li>`).join('')}</ul>`
      : `<ul class="mode-servers">${it.servers.map(([name, sub, href]) => `<li>${href ? `<a href="${href}">` : '<span>'}<span class="mode-logo">${L('server', 16)}</span><span><b>${esc(name)}</b><small>${para(sub)}</small></span>${href ? `${L('chevronRight', 14)}</a>` : '</span>'}</li>`).join('')}</ul>`
  const cards = m.items
    .map(
      (it) => `<li class="mode mode-${it.id}">
          <p class="mode-name">${L(icon[it.id], 15)}<span>${esc(it.name)}</span>${it.tag ? `<span class="tag">${esc(it.tag)}</span>` : ''}</p>
          ${hx('h3', it.head)}
          ${route(it)}
          <p class="mode-privacy">${L('shieldCheck', 15)}<span>${para(it.privacy)}</span></p>
          <dl class="mode-facts">${it.facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${para(v)}</dd></div>`).join('')}</dl>
          <div class="mode-foot"><p class="mode-label">${esc(it.modelsLabel)}</p>${models(it)}</div>
        </li>`,
    )
    .join('\n        ')
  const ai = m.ai
  const aiItems = ai.items.map(([logo, name]) => `<li><span class="logo-tile">${logoImg(logo, 24)}</span><span>${esc(name)}</span></li>`).join('')
  return `<section class="section section-mica" id="models" aria-labelledby="modes-title">
  <div class="wrap">
    <header class="section-head">
      ${hx('h2', m.title, ' id="modes-title"')}
      <p>${para(m.lead)}</p>
    </header>
    <ol class="mode-grid">
        ${cards}
    </ol>
    <div class="apprules ai-strip">
      <div class="apprules-copy"><p class="apprules-title">${esc(ai.title)}</p><p>${para(ai.sub)}</p></div>
      <ul class="apprules-apps">${aiItems}</ul>
    </div>
  </div>
</section>`
}

/* The app itself, rebuilt in HTML so visitors can click through it without installing anything
   (owner, 2026-10-13: a sidebar that swaps screenshots felt wrong). Every control here does
   something; app.js wires them up. Copy comes from the locale's `app` block, which mirrors the
   real UI strings. When the app's layout changes, change this too. */
function appMock(t) {
  const a = t.app
  const n = a.nav
  // Sidebar items exactly as client/src/components/Sidebar.tsx: lucide icons at 16px.
  const navBtn = (id, icon, label) =>
    `<button type="button" class="am-nav-item${id === 'home' ? ' is-on' : ''}" data-am-nav="${id}"${id === 'home' ? ' aria-current="page"' : ''}>${L(icon, 16)}<span>${esc(label)}</span></button>`
  const toggle = (on, label, sync = '') =>
    `<button type="button" class="am-switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}"${sync ? ` data-am-sync="${sync}"` : ''}><i></i></button>`
  const page = (id, body) => `<div class="am-page" data-am-page="${id}"${id === 'home' ? '' : ' hidden'}>${body}</div>`
  const head = (title, sub) => `<h3 class="am-title">${esc(title)}</h3>${sub ? `<p class="am-sub">${para(sub)}</p>` : ''}`
  const statIcon = { clock: 'clock', mic: 'mic', zap: 'zap', type: 'type' }
  const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`)
  const tone = (v) => (v >= 2000 ? 'is-slow' : v >= 900 ? 'is-mid' : 'is-fast')

  const home = page(
    'home',
    `${head(a.home.title)}
        <p class="am-sub">${esc(a.home.subtitle[0])} <kbd class="am-kbd">${esc(a.home.subtitle[1])}</kbd> ${para(a.home.subtitle[2])}</p>
        <div class="am-stats">${a.home.stats
      .map(
        ([ic, label, parts]) =>
          `<div class="am-card am-stat"><span class="am-stat-ico">${L(statIcon[ic], 18)}</span><span><span class="am-stat-label">${esc(label)}</span><span class="am-stat-value">${parts
            .map(([v, u]) => `<b>${esc(v)}</b><small>${esc(u)}</small>`)
            .join('')}</span></span></div>`,
      )
      .join('')}</div>
        <div class="am-card am-recent"><p class="am-recent-label">${esc(a.home.recentLabel)}</p><p class="am-recent-text">${para(a.home.recent)}</p></div>`,
  )

  const h = a.history
  const history = page(
    'history',
    `<div class="am-row"><h3 class="am-title">${esc(h.title)}</h3><span class="am-seg" data-am-hist-tabs>${h.tabs
      .map((x, i) => `<button type="button" class="${i === 0 ? 'is-on' : ''}" data-am-hist-tab="${i}">${esc(x)}</button>`)
      .join('')}</span><label class="am-search">${L('search', 15)}<input type="search" placeholder="${esc(h.search)}" aria-label="${esc(h.search)}" data-am-hist-search></label></div>
        <div class="am-card am-hist"><p class="am-day">${esc(h.day)}</p><ul data-am-hist-list>${h.items
      .map(
        (it, i) => `<li class="am-hist-item${i === 0 ? ' is-open' : ''}" data-am-hist-item>
            <button type="button" class="am-hist-main" aria-expanded="${i === 0}"><span class="am-hist-time">${esc(it.time)}</span><span class="am-hist-text">${para(it.text)}</span></button>
            <button type="button" class="am-icon am-star" aria-pressed="false" aria-label="${esc(h.tabs[1])}">${L('star', 15)}</button>
            <div class="am-hist-more"><p>${esc(h.rawLabel)}：${para(it.raw)}</p><p class="am-tags">${it.meta.map((m) => `<span>${esc(m)}</span>`).join('')}</p></div>
          </li>`,
      )
      .join('')}</ul><p class="am-empty" data-am-hist-empty hidden>${esc(h.empty)}</p></div>`,
  )

  const e = a.engine
  const engine = page(
    'engine',
    `${head(e.title, e.subtitle)}
        <div class="am-card am-block"><div class="am-row"><h4>${esc(e.modeTitle)}</h4><span class="am-ready">${esc(e.ready)}</span></div>
          <div class="am-modes" data-am-choices>${e.modes
      .map(
        (m, i) =>
          `<button type="button" class="am-choice am-mode${i === 1 ? ' is-on' : ''}" data-am-choice data-am-mode="${m.icon}" aria-pressed="${i === 1}"><span class="am-mode-top"><span class="am-check">${L('checkCircle2', 15)}</span><strong>${esc(m.title)}</strong>${L(m.icon, 16, 'am-mode-ico')}</span><span class="am-mode-desc">${para(m.desc)}</span><span class="am-mode-detail">${para(m.detail)}</span></button>`,
      )
      .join('')}</div></div>
        <div class="am-card am-block"><div class="am-row"><h4>${esc(e.asrTitle)}</h4><span class="am-actions"><button type="button" class="am-btn" data-am-test>${L('refreshCw', 14)}${esc(e.testAll)}</button><button type="button" class="am-btn">${L('plus', 14)}${esc(e.add)}</button></span></div>
          <p class="am-hint">${para(e.asrDesc)}</p>
          <div class="am-grid" data-am-choices>${e.cards
      .map(
        ([name, model, v, desc], i) =>
          `<button type="button" class="am-choice am-prov${i === 0 ? ' is-on' : ''}" data-am-choice aria-pressed="${i === 0}"><span class="am-prov-top"><span class="am-check">${L('checkCircle2', 14)}</span><strong>${esc(name)}</strong><span class="am-ms ${tone(v)}" data-am-ms="${v}">${ms(v)}</span></span><span class="am-prov-model">${esc(model)}</span><span class="am-prov-desc">${para(desc)}</span></button>`,
      )
      .join('')}</div></div>`,
  )

  const hw = a.hotwords
  const hotwords = page(
    'hotwords',
    `${head(hw.title, hw.subtitle)}
        <div class="am-card am-block"><form class="am-add" data-am-hot-form><input type="text" placeholder="${esc(hw.placeholder)}" aria-label="${esc(hw.placeholder)}" maxlength="40" data-am-hot-input><button type="submit" class="am-btn am-btn-dark">${L('plus', 14)}${esc(hw.add)}</button></form>
          <ul class="am-chips" data-am-hot-list data-remove="${esc(hw.remove)}">${hw.words
      .map((w) => `<li><span>${esc(w)}</span><button type="button" aria-label="${esc(hw.remove)} ${esc(w)}">${L('x', 12)}</button></li>`)
      .join('')}</ul></div>`,
  )

  const ai = a.ai
  const aiPage = page(
    'ai',
    `${head(ai.title, ai.subtitle)}
        ${ai.toggles.map(([title, desc, on], i) => `<div class="am-card am-toggle-row"><span><strong>${esc(title)}</strong><small>${para(desc)}</small></span>${toggle(on, title, i === 0 ? 'ai' : '')}</div>`).join('')}
        <div class="am-card am-block"><div class="am-row"><span><h4>${esc(ai.presetsTitle)}</h4><p class="am-hint">${para(ai.presetsDesc)}</p></span><span class="am-actions"><span class="am-seg">${ai.langs.map((l, i) => `<button type="button" class="${i === (t.lang === 'en' ? 1 : 0) ? 'is-on' : ''}" data-am-seg>${esc(l)}</button>`).join('')}</span><button type="button" class="am-btn">${L('plus', 14)}${esc(ai.add)}</button></span></div>
          <ul class="am-presets" data-am-choices>${ai.presets
      .map(
        ([name, prompt], i) => `<li class="am-choice am-preset${i === 0 ? ' is-on' : ''}" data-am-choice>
            <span class="am-radio" aria-hidden="true"></span>
            <span class="am-preset-body"><span class="am-preset-name">${esc(name)}<span class="am-badge">${esc(ai.builtin)}</span></span><span class="am-preset-line">${esc(prompt.split('\n')[0])}</span>
              <span class="am-preset-edit" hidden><textarea rows="5" aria-label="${esc(ai.edit)}">${esc(prompt)}</textarea><small>${para(ai.editHint)}</small></span></span>
            <button type="button" class="am-icon" data-am-edit aria-label="${esc(ai.edit)}">${L('pencil', 15)}</button>
          </li>`,
      )
      .join('')}</ul></div>`,
  )

  const p = a.providers
  const providers = page(
    'providers',
    `${head(p.title, p.subtitle)}
        <div class="am-card am-block"><div class="am-row"><span><h4>${esc(p.cardTitle)}</h4><p class="am-hint">${para(p.cardDesc)}</p></span><span class="am-actions"><button type="button" class="am-btn" data-am-test>${L('refreshCw', 14)}${esc(p.testAll)}</button><button type="button" class="am-btn">${L('plus', 14)}${esc(p.add)}</button></span></div>
          <div class="am-grid" data-am-choices>${p.items
      .map(
        ([model, vendor, v], i) =>
          `<button type="button" class="am-choice am-prov${i === 0 ? ' is-on' : ''}" data-am-choice aria-pressed="${i === 0}"><span class="am-prov-top"><span class="am-check">${L('checkCircle2', 14)}</span><strong>${esc(model)}</strong><span class="am-ms ${tone(v)}" data-am-ms="${v}">${ms(v)}</span></span><span class="am-prov-model">${esc(vendor)}</span></button>`,
      )
      .join('')}</div></div>`,
  )

  /* The settings sheet: the app's SettingsDialog with its four pages (General, Appearance, Usage,
     Diagnostics), each clickable. Sections follow the order of the real pages. */
  const st = a.settings
  const sg = st.general
  const ap = st.appearance
  const ss = st.stats
  const sd = st.diag
  const swatch = { light: ['#ffffff', '#ffffff', '#18181b', '#f4f4f5'], dark: ['#18181b', '#27272a', '#3b82f6', '#3f3f46'], warm: ['#faf9f5', '#ebe8e0', '#c2541b', '#e8e6e0'] }
  const waveSwatch = { white: ['#e5e7eb', '#e5e7eb', '#e5e7eb'], blue: ['#38bdf8', '#22a7ee', '#3b8fe8'], rainbow: ['#4ade80', '#facc15', '#fb923c', '#f87171'] }
  const choiceRow = (items, attr, on, render) =>
    `<div class="am-opts" data-am-choices>${items.map(([id, label]) => `<button type="button" class="am-choice am-opt${id === on ? ' is-on' : ''}" data-am-choice aria-pressed="${id === on}" ${attr}="${id}"><span class="am-radio" aria-hidden="true"></span><span>${esc(label)}</span>${render ? render(id) : ''}</button>`).join('')}</div>`
  const line = (title, desc, control) => `<div class="am-toggle-line"><span><strong>${esc(title)}</strong>${desc ? `<small>${para(desc)}</small>` : ''}</span>${control}</div>`
  const select = (label, value, options) =>
    `<label class="am-select"><select aria-label="${esc(label)}">${options.map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>${L('chevronDown', 14)}</label>`
  const setPage = (id, body) => `<div class="am-set-page" data-am-set-page="${id}"${id === 'general' ? '' : ' hidden'}>${body}</div>`

  const general = setPage(
    'general',
    `<h3 class="am-title">${esc(sg.title)}</h3>
            <div class="am-card am-block"><h4>${esc(sg.language.title)}</h4><p class="am-hint">${para(sg.language.hint)}</p>${select(sg.language.title, sg.language.value, sg.language.options)}</div>
            <div class="am-card am-block"><h4>${esc(sg.shortcuts.title)}</h4><p class="am-hint">${para(sg.shortcuts.esc)}</p>
              ${sg.shortcuts.items.map(([name, desc, key]) => line(name, desc, `<button type="button" class="am-key" data-am-key>${esc(key)}</button>`)).join('')}</div>
            <div class="am-card am-block"><h4>${esc(sg.mic.title)}</h4><div class="am-row">${select(sg.mic.label, sg.mic.value, sg.mic.options)}<button type="button" class="am-btn" data-am-mic-test data-testing="${esc(sg.mic.testing)}">${L('mic', 14)}<span>${esc(sg.mic.test)}</span></button></div><span class="am-meter" aria-hidden="true"><i></i></span></div>
            <div class="am-card am-block"><h4>${esc(sg.prefs.title)}</h4>${sg.prefs.items.map(([title, desc, on]) => line(title, desc, toggle(on, title))).join('')}</div>
            <div class="am-card am-block"><h4>${esc(sg.app.title)}</h4>${line(sg.app.item[0], sg.app.item[1], toggle(true, sg.app.item[0]))}</div>
            <div class="am-card am-block">${line(sg.history.title, sg.history.desc, toggle(true, sg.history.title))}</div>
            <div class="am-card am-block">${line(sg.audio.title, sg.audio.desc, select(sg.audio.label, sg.audio.value, sg.audio.options))}</div>`,
  )

  const appearance = setPage(
    'appearance',
    `<h3 class="am-title">${esc(ap.title)}</h3>
            <div class="am-card am-block"><h4>${esc(ap.themeTitle)}</h4>${choiceRow(ap.themes, 'data-am-theme', 'light', (id) => `<span class="am-swatch">${swatch[id].map((c) => `<i style="background:${c}"></i>`).join('')}</span>`)}</div>
            <div class="am-card am-block"><h4>${esc(ap.overlayTitle)}</h4>
              <p class="am-label">${esc(ap.waveLabel)}</p>${choiceRow(ap.waves, 'data-am-wave', 'rainbow', (id) => `<span class="am-wave-sw">${waveSwatch[id].map((c) => `<i style="background:${c}"></i>`).join('')}</span>`)}
              <p class="am-label">${esc(ap.lengthLabel)}</p>${choiceRow(ap.lengths, 'data-am-len', 'short')}
              ${line(ap.durationTitle, ap.durationDesc, toggle(true, ap.durationTitle, 'duration'))}
              ${line(ap.streamTitle, ap.streamDesc, toggle(true, ap.streamTitle, 'stream'))}
              <div class="am-preview" data-am-preview>
                <div class="ov am-ov">${ovCaption(t, ap.previewText)}${ovPill(t, { secs: 3, think: false })}</div>
                <p>${esc(ap.preview)}</p>
              </div>
            </div>`,
  )

  const maxHour = Math.max(...ss.hours)
  const bar = (label, value, max, unit) => `<li><span class="am-bar-label">${esc(label)}</span><span class="am-bar-track"><i style="width:${Math.round((value / max) * 100)}%"></i></span><span class="am-bar-val">${esc(String(value))}${esc(unit)}</span></li>`
  const statsPage = setPage(
    'stats',
    `<h3 class="am-title">${esc(ss.title)}</h3><p class="am-sub">${para(ss.since)}</p>
            <div class="am-kpis">${ss.cards.map(([label, value]) => `<div class="am-card am-kpi"><small>${esc(label)}</small><b>${esc(value)}</b></div>`).join('')}</div>
            <div class="am-card am-block"><h4>${esc(ss.hoursTitle)}</h4><div class="am-hours" role="img" aria-label="${esc(ss.hoursTitle)}">${ss.hours.map((v, i) => `<i style="height:${Math.max(4, Math.round((v / maxHour) * 100))}%" title="${i}:00 · ${v}"></i>`).join('')}</div><p class="am-hours-axis">${ss.buckets.map((b) => `<span>${esc(b)}</span>`).join('')}</p></div>
            <div class="am-two">
              <div class="am-card am-block"><h4>${esc(ss.modeTitle)}</h4><ul class="am-bars">${ss.modes.map(([l, v]) => bar(l, v, 100, '%')).join('')}</ul></div>
              <div class="am-card am-block"><h4>${esc(ss.presetTitle)}</h4><ul class="am-bars">${ss.presets.map(([l, v]) => bar(l, v, 100, '%')).join('')}</ul></div>
            </div>
            <div class="am-card am-block"><h4>${esc(ss.appsTitle)}</h4><ul class="am-bars">${ss.apps.map(([l, v]) => bar(l, v, ss.apps[0][1], ss.timesUnit)).join('')}</ul></div>`,
  )

  const diagPage = setPage(
    'diag',
    `<h3 class="am-title">${esc(sd.title)}</h3>
            <div class="am-card am-block"><div class="am-row"><h4>${esc(sd.statusTitle)}</h4><span class="am-actions"><button type="button" class="am-btn" data-am-diag-refresh data-checking="${esc(sd.checking)}">${L('refreshCw', 14)}<span>${esc(sd.refresh)}</span></button></span></div>
              <ul class="am-health" data-am-health>${sd.rows.map(([label, value]) => `<li>${L('checkCircle2', 15, 'am-ok')}<span class="am-health-label">${esc(label)}</span><span class="am-health-val">${para(value)}</span></li>`).join('')}</ul></div>
            <div class="am-card am-block"><h4>${esc(sd.faqTitle)}</h4>
              <details class="am-faq"><summary>${L('helpCircle', 15)}<span>${esc(sd.faq.q)}</span>${L('chevronDown', 14, 'am-faq-chev')}</summary><ol>${sd.faq.items.map(([b, rest]) => `<li><strong>${esc(b)}</strong>${para(rest)}</li>`).join('')}</ol><p class="am-hint">${para(sd.faq.footer)}</p></details></div>
            <div class="am-card am-block"><div class="am-row"><span><h4>${esc(sd.logTitle)}</h4><p class="am-hint">${para(sd.logHint)}</p></span><span class="am-actions"><span class="am-seg" data-am-log-tabs>${sd.logTabs.map(([id, label], i) => `<button type="button" class="${i === 2 ? 'is-on' : ''}" data-am-log="${id}">${esc(label)}</button>`).join('')}</span><button type="button" class="am-icon" aria-label="${esc(sd.openFolder)}">${L('folderOpen', 15)}</button></span></div>
              <pre class="am-log" data-am-log-view>${sd.log.map(([lvl, text]) => `<span class="lv-${lvl}" data-lv="${lvl}">${esc(text)}</span>`).join('')}</pre></div>`,
  )

  const settings = `<div class="am-modal" data-am-modal hidden>
        <div class="am-modal-box" role="dialog" aria-label="${esc(sg.title)}">
          <nav class="am-modal-nav">${st.nav.map(([id, label, icon]) => `<button type="button" class="${id === 'general' ? 'is-on' : ''}" data-am-set-nav="${id}">${L(icon, 16)}<span>${esc(label)}</span></button>`).join('')}</nav>
          <div class="am-modal-body">
            <button type="button" class="am-icon am-close" data-am-close aria-label="${esc(st.close)}">${L('x', 16)}</button>
            ${general}
            ${appearance}
            ${statsPage}
            ${diagPage}
          </div>
        </div>
      </div>`
  const about = page('about', `${head(a.about.title)}<div class="am-card am-block am-about"><img src="/logo-72.png" width="44" height="44" alt=""><span><strong>SayIt</strong><small>${para(a.about.line)}</small><small data-version data-template="{v}" hidden></small></span><a class="am-btn" href="${REPO}" rel="noopener">${I.github({ size: 14 })}${esc(a.about.github)}</a></div>`)

  // Centred over the centred window: a left-aligned heading above a 1000px window centred in the
  // 1200px column started 100px left of it (owner, 2026-10-19: ugly). The chips are shortcuts into
  // the window below, so the lead does not have to list what can be clicked.
  const tries = a.tries.map(([go, label]) => `<button type="button" class="am-try" data-am-go="${go}">${esc(label)}</button>`).join('')
  return `<section class="section" id="app" aria-labelledby="app-title">
  <div class="wrap">
    <header class="section-head is-center">
      ${hx('h2', a.title, ' id="app-title"')}
      <p>${para(a.lead)}</p>
      <p class="am-tries"><span>${esc(a.tryLabel)}</span>${tries}</p>
    </header>
    <div class="am" data-am data-theme="light">
      <div class="am-bar">
        <span class="am-brand"><img src="/logo-72.png" width="20" height="20" alt=""><strong>${esc(a.window)}</strong></span>
        <span class="am-bar-right"><span class="am-ai">${L('wand2', 15)}${esc(a.aiToggle)}</span>${toggle(true, a.aiToggle, 'ai')}<span class="am-caps" aria-hidden="true">${L('minus', 16)}${L('square', 13)}${L('x', 16)}</span></span>
      </div>
      <div class="am-body">
        <nav class="am-side" aria-label="${esc(a.window)}">
          <div class="am-nav-group">${navBtn('home', 'home', n.home)}${navBtn('history', 'clock', n.history)}</div>
          <div class="am-nav-group">${navBtn('engine', 'audioLines', n.engine)}${navBtn('hotwords', 'bookOpen', n.hotwords)}${navBtn('ai', 'wand2', n.ai)}${navBtn('providers', 'sparkles', n.providers)}</div>
          <div class="am-side-foot"><button type="button" class="am-icon" data-am-open-settings aria-label="${esc(n.settings)}">${L('settings', 16)}</button><button type="button" class="am-icon" data-am-nav="about" aria-label="${esc(n.about)}">${L('info', 16)}</button><span class="am-icon am-conn" aria-hidden="true" data-am-conn><span data-conn="cpu" hidden>${L('cpu', 16)}</span><span data-conn="cloud">${L('cloud', 16)}</span><span data-conn="server" hidden>${L('wifi', 16)}</span></span></div>
        </nav>
        <div class="am-main">
          ${home}
          ${history}
          ${engine}
          ${hotwords}
          ${aiPage}
          ${providers}
          ${about}
        </div>
      </div>
      ${settings}
    </div>
  </div>
</section>`
}

function demo(t) {
  const d = t.demo
  const rates = [0.75, 1, 1.5, 2]
    .map((r) => `<button type="button" class="rate" data-rate="${r}" aria-pressed="${r === 1}">${r}×</button>`)
    .join('')
  return `<section class="section section-mica" id="demo" aria-labelledby="demo-title">
  <div class="wrap demo-grid">
    <header class="section-head">
      ${hx('h2', d.title, ' id="demo-title"')}
      <p>${para(d.lead)}</p>
      <ul class="demo-points">${d.points.map(([icon, text]) => `<li><span class="team-fact-ico">${L(icon, 15)}</span><span>${para(text)}</span></li>`).join('')}</ul>
    </header>
    <div class="win demo">
      <div class="win-bar"><span class="win-app"><img src="/logo-72.png" width="14" height="14" alt=""></span><span class="win-title">${esc(d.window)}</span>${caps}</div>
      <div class="demo-body">
        <div class="demo-stage">
          <button class="rec-btn" id="recordButton" type="button" aria-label="${esc(d.start)}" disabled>${I.mic({ size: 26, cls: 'ico-mic' })}${I.stop({ size: 22, cls: 'ico-stop' })}</button>
          <div class="ov ov-demo" aria-hidden="true">${ovPill(t, { quiet: true, attrs: ' id="demoPill"', barsId: 'demoBars', timerId: 'timer', think: false })}</div>
          <p class="demo-state" role="status" aria-live="polite"><span class="state-dot" id="stateDot"></span><span id="stateText">…</span></p>
        </div>
        <!-- Output, top to bottom: what came back (label says whether AI cleaned it up), the raw
             transcript when it differs, timings, then the recording. The player is two rows so the
             speed buttons can never sit on top of the track (owner, 2026-10-18). -->
        <div class="demo-output">
          <div class="result-head"><p class="result-label" id="resultLabel">${esc(d.resultLabel)}</p><button class="icon-btn copy-btn" id="copyResult" type="button" aria-label="${esc(d.copy)}" title="${esc(d.copy)}" hidden>${I.copy({ size: 16, cls: 'ico-copy' })}${I.check({ size: 16, cls: 'ico-check' })}</button></div>
          <p class="result-text is-placeholder" id="resultText" data-placeholder="${esc(d.placeholder)}">${esc(d.placeholder)}</p>
          <p class="result-note" id="resultNote" hidden></p>
          <div class="result-raw" id="resultDetails" hidden><p class="label">${esc(d.rawLabel)}</p><p id="asrText"></p></div>
          <p class="result-meta" id="resultMeta"></p>
          <div class="playback" id="playbackSection" hidden>
            <div class="pb-main">
              <button class="icon-btn play-btn" id="playBtn" type="button" aria-label="${esc(d.play)}">${I.play({ size: 15, cls: 'ico-play' })}${I.pause({ size: 15, cls: 'ico-pause' })}</button>
              <input type="range" id="trackInput" min="0" max="1000" step="1" value="0" aria-label="${esc(d.play)}">
              <span class="track-time" id="playTime">0:00 / 0:00</span>
            </div>
            <div class="pb-tools">
              <div class="rates" role="group" aria-label="${esc(d.speed)}">${rates}</div>
              <button class="icon-btn" id="dlAudioBtn" type="button" aria-label="${esc(d.downloadAudio)}" title="${esc(d.downloadAudio)}">${I.download({ size: 16 })}</button>
              <button class="btn btn-standard btn-sm" id="clearBtn" type="button" hidden>${I.replay({ size: 15 })}<span>${esc(d.again)}</span></button>
            </div>
          </div>
        </div>
      </div>
      <noscript><p class="demo-noscript">${esc(d.noscript)}</p></noscript>
    </div>
  </div>
</section>`
}

function selfhost(t) {
  const s = t.selfhost
  const cmd = (c) => `<span class="t-line"><span class="t-p" aria-hidden="true">$ </span>${esc(c)}</span>`
  const lines = [
    cmd('git clone https://github.com/crosswk/SayIt.git'),
    cmd('cd SayIt/server'),
    cmd('cp config.example.yaml config.yaml'),
    cmd('cp .env.example .env'),
    cmd('docker compose up -d --build'),
  ].join('\n')
  const rows = s.perfRows.map((r) => `<tr><th scope="row">${esc(r[0])}</th><td>${esc(r[1])}</td></tr>`).join('')
  const d = s.diagram
  /* A picture of the boundary, not a feature list (the owner found the old text-heavy version hard
     to read, 2026-10-16): three teammates talking (each with the overlay running), their voices
     flowing along the wires into one server, the optional in-house model behind it, and the
     internet outside with the line cut. The wires converge on the middle row, so the server sits in
     the middle row of a 1fr / auto / 1fr column. */
  const people = d.people
    .map((role, i) => `<div class="lan-person" style="grid-row:${i + 1}"><span class="lan-dev">${L('laptop', 18)}</span><span class="lan-role">${esc(role)}</span>${ovPill(t, { secs: 3, think: false })}</div>`)
    .join('')
  const wire = (d0) => `<path d="${d0}" class="lan-wire"/><path d="${d0}" class="lan-flow"/>`
  return `<section class="section" id="self-host" aria-labelledby="selfhost-title">
  <div class="wrap split split-team">
    <div class="split-copy">
      ${hx('h2', s.title, ' id="selfhost-title"')}
      <p>${para(s.lead)}</p>
      <ul class="team-facts">${s.facts.map(([icon, text]) => `<li><span class="team-fact-ico">${L(icon, 16)}</span><span>${para(text)}</span></li>`).join('')}</ul>
      <div class="split-actions">
        <a class="btn btn-standard" href="${REPO}" rel="noopener">${I.github({ size: 16 })}<span>${esc(s.github)}</span></a>
        <a class="link" href="${DOCS.server}" rel="noopener">${esc(s.guide)}${I.arrow({ size: 16 })}</a>
      </div>
    </div>
    <figure class="lan" aria-hidden="true">
      <div class="lan-outside"><span class="lan-net">${L('globe', 15)}<span>${esc(d.outside)}</span></span><span class="lan-cut"><i>${L('x', 11)}</i></span><small>${esc(d.blocked)}</small></div>
      <div class="lan-box">
        <p class="lan-label">${L('shieldCheck', 14)}<span>${esc(d.boundary)}</span></p>
        ${people}
        <svg class="lan-wires" viewBox="0 0 60 300" preserveAspectRatio="none">${wire('M0 50 C 32 50 28 150 60 150')}${wire('M0 150 L 60 150')}${wire('M0 250 C 32 250 28 150 60 150')}</svg>
        <div class="lan-servers">
          <div class="lan-node is-main"><span class="lan-node-ico">${L('server', 18)}</span><span><strong>${esc(d.server)}</strong><small>${esc(d.serverSub)}</small></span></div>
          <div class="lan-llm"><span class="lan-vline"></span><div class="lan-node"><span class="lan-node-ico">${L('sparkles', 16)}</span><span><strong>${esc(d.llm)}</strong><small>${esc(d.llmSub)}</small></span></div></div>
        </div>
      </div>
    </figure>
  </div>
  <div class="wrap team-foot">
    <div class="terminal term-mini">
      <div class="term-bar"><span class="term-tab">${I.terminal({ size: 14 })}<span>${esc(s.terminal || 'Ubuntu')}</span></span><button class="icon-btn term-copy" type="button" data-copy-terminal aria-label="${esc(t.demo.copy)}" title="${esc(t.demo.copy)}" hidden>${I.copy({ size: 15, cls: 'ico-copy' })}${I.check({ size: 15, cls: 'ico-check' })}</button>${caps}</div>
      <pre class="term-body"><code>${lines}</code></pre>
    </div>
    <div class="perf-card">
      <p class="perf-bar" aria-hidden="true"><b>${esc(s.perfTitle)}</b><small>${esc(s.perfCaption)}</small></p>
      <table class="perf">
        <caption class="sr-only">${esc(s.perfTitle)} · ${esc(s.perfCaption)}</caption>
        <thead><tr>${s.perfHead.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
</section>`
}

function faq(t) {
  const items = t.faq.items
    .map(
      (it) => `<details class="faq-item">
        <summary><span>${para(it.q)}</span>${I.chevron({ size: 16 })}</summary>
        <div class="faq-a"><p>${para(it.a)}</p></div>
      </details>`,
    )
    .join('\n      ')
  return `<section class="section" id="faq" aria-labelledby="faq-title">
  <div class="wrap faq-grid">
    <header class="section-head">${hx('h2', t.faq.title, ' id="faq-title"')}</header>
    <div class="faq">
      ${items}
    </div>
  </div>
</section>`
}

// Words and the two actions only. A keycap beside a big pill read as decoration (owner, 2026-10-13).
function closer(t) {
  return `<section class="closer" aria-labelledby="closer-title">
  <div class="closer-inner wrap">
    ${hx('h2', t.closer.title, ' id="closer-title"')}
    <p>${para(t.closer.lead)}</p>
    <div class="closer-actions">
      ${downloadButtons(t)}
      <a class="btn btn-standard btn-lg" href="${REPO}" rel="noopener">${I.github({ size: 18 })}<span>GitHub</span></a>
    </div>
  </div>
</section>`
}

/* One button per platform (owner, 2026-11-03). Windows is the accent in the static HTML; app.js
   moves the accent to the Mac button for Mac visitors, so each visitor's own platform reads first
   without the page reordering itself after load.
   The Windows button takes the server's download endpoint when it has one ([data-download-win]);
   the Mac one always points at the GitHub release, where the dmg is, because that endpoint only
   serves the Windows installer. */
function downloadButtons(t) {
  const h = t.hero
  return `<a class="btn btn-accent btn-lg" href="${RELEASES}" data-download-win data-dl-platform="win">${I.windows({ size: 18 })}<span>${esc(h.cta)}</span></a>
        <a class="btn btn-standard btn-lg" href="${RELEASES}" rel="noopener" data-dl-platform="mac">${I.apple({ size: 18 })}<span>${esc(h.ctaMac)}</span></a>`
}

function footer(t) {
  const f = t.footer
  const li = (href, label, ext = true) => (label ? `<li><a href="${href}"${ext ? ' rel="noopener"' : ''}>${esc(label)}</a></li>` : '')
  const wechat = f.wechat
    ? `<figure class="wechat"><img src="/img/wechat-official-account.jpg" width="120" height="120" loading="lazy" alt="${esc(f.wechat)}"><figcaption>${para(f.wechat)}</figcaption></figure>`
    : ''
  return `<footer class="footer">
  <div class="wrap footer-grid">
    <div class="footer-brand">
      <a class="brand" href="${t.path}" aria-label="${esc(t.nav.home)}"><img src="/logo-72.png" width="28" height="28" alt=""><span>SayIt</span></a>
      <p>${para(f.tagline)}</p>
      ${wechat}
    </div>
    <nav class="footer-col" aria-label="${esc(f.product)}">
      <p class="footer-h">${esc(f.product)}</p>
      <ul>${li(RELEASES, f.download)}${li(DOCS.releases, f.releases)}${li(DOCS.changelog, f.changelog)}${li('#demo', f.demo, false)}</ul>
    </nav>
    <nav class="footer-col" aria-label="${esc(f.docs)}">
      <p class="footer-h">${esc(f.docs)}</p>
      <ul>${li(DOCS.asr, f.asrGuide)}${li(DOCS.ai, f.aiGuide)}${li(DOCS.server, f.serverGuide)}</ul>
    </nav>
    <nav class="footer-col" aria-label="${esc(f.community)}">
      <p class="footer-h">${esc(f.community)}</p>
      <ul>${li(DOCS.issues, f.issues)}${HAS_FEEDBACK ? li('/feedback.html', f.feedback, false) : ''}${li(DOCS.video, f.video)}${li(DOCS.contributing, f.contributing)}</ul>
    </nav>
  </div>
  <div class="wrap footer-bottom">
    <p>${esc(f.license)} ${esc(f.credits)} <span data-version data-template="${esc(f.version)}" hidden></span></p>
    <p class="footer-lang"><a href="/" hreflang="en" lang="en"${t.lang === 'en' ? ' aria-current="page"' : ''}>English</a><a href="/zh/" hreflang="zh-CN" lang="zh-CN"${t.lang !== 'en' ? ' aria-current="page"' : ''}>简体中文</a></p>
  </div>
</footer>`
}

function structuredData(t) {
  const url = ORIGIN + t.path
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', '@id': `${ORIGIN}/#website`, url: `${ORIGIN}/`, name: 'SayIt', inLanguage: ['en', 'zh-CN'] },
      {
        '@type': 'SoftwareApplication',
        '@id': `${ORIGIN}/#app`,
        name: 'SayIt',
        url,
        description: t.meta.description,
        inLanguage: t.lang,
        applicationCategory: 'UtilitiesApplication',
        applicationSubCategory: t.jsonld.category,
        operatingSystem: 'Windows 10, Windows 11, macOS 14',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        license: LICENSE_URL,
        downloadUrl: RELEASES,
        image: ORIGIN + t.meta.ogImage,
        screenshot: `${ORIGIN}/img/app/voice-engine-${t.lang === 'en' ? 'en' : 'zh'}.jpg`,
        featureList: t.jsonld.features,
        author: { '@type': 'Person', name: 'crosswk', url: 'https://github.com/crosswk' },
        sameAs: [REPO],
      },
      {
        '@type': 'SoftwareSourceCode',
        '@id': `${ORIGIN}/#source`,
        name: 'SayIt',
        codeRepository: REPO,
        programmingLanguage: ['Rust', 'TypeScript', 'Python'],
        license: LICENSE_URL,
        targetProduct: { '@id': `${ORIGIN}/#app` },
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        inLanguage: t.lang,
        mainEntity: t.faq.items.map((it) => ({ '@type': 'Question', name: it.q, acceptedAnswer: { '@type': 'Answer', text: it.a } })),
      },
    ],
  }
}

/* Design brief for the page. Kept here as a JS comment on purpose: it used to sit in an HTML
   comment inside the template, so every visitor got it in the page source, along with a pointer
   to a private notes file. Anything written inside the template literal below ships to the web.

   THESIS: SayIt is how people talk to their AI tools on Windows. The first viewport shows exactly
   that: a spoken, messy request becoming a clean prompt in Claude Code, Codex and Kiro.
   Positioning: .kiro/design/positioning.md.
   OWN-WORLD: the app's own default theme: zinc white and near-black (#18181B primary), hairline
   zinc strokes. The only colour is the overlay's default rainbow waveform (hue 140 -> 30).
   No wallpaper, no gradient blobs, no feature-card grids. Segoe UI Variable / Microsoft YaHei UI;
   Cascadia Mono for terminal text.
   STORY: messy speech in, clean text out (shown, not explained) -> your prompts (the app's real
   preset card) -> your company's server -> where recognition runs and which models -> the app
   itself -> try it -> download.
   FIRST VIEWPORT: left: one-line tagline, one sentence, Download + Try in browser, three facts
   that are the reasons to switch. Right: Claude Code (TUI in Windows Terminal), the Codex desktop
   app and Kiro IDE behind a switcher, each drawn as it really looks; the app's overlay sits below
   the window. */
function page(t) {
  const other = LOCALES.find((x) => x !== t)
  const url = ORIGIN + t.path
  const v = { css: fileHash('style.css'), js: fileHash('app.js') }
  const img = ORIGIN + t.meta.ogImage
  return `<!DOCTYPE html>
<!-- Generated by server/site/build.mjs from server/site/locales/${t.locale}.mjs. Edit those, then run: node server/site/build.mjs -->
<html lang="${t.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(t.meta.title)}</title>
  <meta name="description" content="${esc(t.meta.description)}">
  <link rel="canonical" href="${url}">
  <link rel="alternate" hreflang="en" href="${ORIGIN}/">
  <link rel="alternate" hreflang="zh-CN" href="${ORIGIN}/zh/">
  <link rel="alternate" hreflang="x-default" href="${ORIGIN}/">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#ffffff">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="SayIt">
  <meta property="og:title" content="${esc(t.meta.title)}">
  <meta property="og:description" content="${esc(t.meta.description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${img}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${esc(t.meta.ogImageAlt)}">
  <meta property="og:locale" content="${t.ogLocale}">
  <meta property="og:locale:alternate" content="${other.ogLocale}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(t.meta.title)}">
  <meta name="twitter:description" content="${esc(t.meta.description)}">
  <meta name="twitter:image" content="${img}">
  <meta name="twitter:image:alt" content="${esc(t.meta.ogImageAlt)}">
  <link rel="icon" type="image/x-icon" href="/favicon.ico">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/style.css?v=${v.css}">
  <script type="application/ld+json">${jsonLd(structuredData(t))}</script>
</head>
<body class="page-home">
<a class="skip-link" href="#main">${esc(t.skip)}</a>
${header(t)}
<main id="main">
${hero(t)}
${cleanup(t)}
${rules(t)}
${selfhost(t)}
${modes(t)}
${appMock(t)}
${demo(t)}
${faq(t)}
${closer(t)}
</main>
${footer(t)}
<script src="/app.js?v=${v.js}" defer></script>
</body>
</html>
`
}

/* ── side files ──────────────────────────────────────────────────────────── */

function robots() {
  const ai = [
    'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
    'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'Bytespider',
    'CCBot', 'Amazonbot', 'DuckAssistBot', 'meta-externalagent', 'MistralAI-User',
  ]
  const rules = 'Allow: /\nDisallow: /api/\nDisallow: /ws/\n'
  return `# SayIt public site. Search engines and AI assistants are welcome to read and cite it.
# Machine-readable summary: ${ORIGIN}/llms.txt

User-agent: *
${rules}
# AI search and assistant crawlers, allowed explicitly so a blanket policy elsewhere never shuts them out.
${ai.map((a) => `User-agent: ${a}`).join('\n')}
${rules}
Sitemap: ${ORIGIN}/sitemap.xml
`
}

function sitemap() {
  const alt = `<xhtml:link rel="alternate" hreflang="en" href="${ORIGIN}/"/><xhtml:link rel="alternate" hreflang="zh-CN" href="${ORIGIN}/zh/"/><xhtml:link rel="alternate" hreflang="x-default" href="${ORIGIN}/"/>`
  const url = (loc) => `  <url><loc>${loc}</loc><lastmod>${UPDATED}</lastmod>${alt}</url>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${url(`${ORIGIN}/`)}
${url(`${ORIGIN}/zh/`)}
</urlset>
`
}

function llms() {
  const faqEn = en.faq.items.map((it) => `### ${it.q}\n\n${it.a}`).join('\n\n')
  return `# SayIt

> SayIt is a free, open-source (AGPL-3.0) voice typing app for Windows 10 and 11 and for macOS 14 or later on Apple silicon. Press a shortcut in any app, speak, and SayIt transcribes, cleans up and types polished text at the cursor. Speech recognition runs locally on your computer, through your own cloud API keys, or on a SayIt server (the public trial server or one you host).

SayIt 是一款免费开源的语音输入法，支持 Windows 和 Mac：在任何应用里按快捷键说话，整理好的文字直接输入到光标处。中文介绍：${ORIGIN}/zh/

## Key facts

- Platforms: Windows 10 and 11 (x64), and macOS 14 or later on Apple silicon (M1 or later). No Intel Mac, Linux or mobile version.
- Price: free, no account, no subscription. Licensed under AGPL-3.0.
- Not an input method: it runs on a global shortcut next to whatever keyboard or IME you already use.
- Default shortcut: press Right Alt (Right ⌘ on a Mac) once to start and again to finish; hold-to-talk is on a separate shortcut (Right Ctrl on Windows, Right ⌥ on a Mac).
- Common use: dictating prompts to AI coding tools such as Claude Code, Codex, Kiro and Cursor. It types at the cursor, so terminals, IDEs, browsers and chat apps all work.
- AI cleanup removes filler words, follows self-corrections, formats spoken lists and fixes names and terms. Every prompt is editable, prompts can switch per app, and cleanup can be turned off.
- Local mode: seven GGUF models (Parakeet Unified EN, SenseVoice Small, Fun-ASR Nano, Nemotron 3.5 ASR with 32 languages, three Qwen3-ASR sizes). About 9 s of speech is transcribed in under a second on a CPU; a GPU is used when present.
- Cloud API mode: speech recognition with your own keys for Doubao, Qwen, OpenAI, Gemini, OpenRouter, Xiaomi MiMo, Groq Whisper or any OpenAI-compatible endpoint; audio goes straight to the provider.
- Cleanup prompts are fully editable: built-in styles (intent cleanup, faithful proofread, Chinese to English, conversational) can be changed, new ones written from scratch, and a different one picked automatically per app.
- Server mode is the default and connects to the public trial server; teams can host their own with Docker Compose (FastAPI, WebSocket, Qwen3-ASR with vLLM, NVIDIA GPU with 16 GB+ VRAM recommended) so audio and text stay inside the company network.
- Other features: context-aware writing (off by default), speak to edit a selection, hotwords, live captions in the overlay, searchable local history with re-transcribe.
- App interface languages: English and Simplified Chinese.
- Server benchmark (Qwen3-ASR-1.7B + vLLM, NVIDIA A10G 24 GB): 30 s audio ~0.8 s, 1 min ~1.6 s, 5 min ~3.0 s.

## Links

- [Download the latest release](${RELEASES}): Windows installer and Mac dmg
- [Source code on GitHub](${REPO})
- [README](${DOCS.readme}): overview, modes, models and self-hosting
- [README in Chinese](${DOCS.readmeZh})
- [Server guide](${DOCS.server}): configuration, deployment, security and API
- [Changelog](${DOCS.changelog})
- [Speech recognition setup, in Chinese](${DOCS.asr})
- [AI cleanup provider setup, in Chinese](${DOCS.ai})

## FAQ

${faqEn}
`
}

/* ── write ───────────────────────────────────────────────────────────────── */

function write(rel, content) {
  const p = path.join(WEB, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, 'utf8')
  console.log(`wrote server/web/${rel.replace(/\\/g, '/')} (${Buffer.byteLength(content)} bytes)`)
}

// No wallpaper any more: the owner found the radial bloom unrelated to the product (2026-10-13).
write('index.html', page(en))
write('zh/index.html', page(zh))
write('robots.txt', robots())
write('sitemap.xml', sitemap())
write('llms.txt', llms())
console.log(`feedback link: ${HAS_FEEDBACK ? 'on (feedback.html present)' : 'off'}`)
