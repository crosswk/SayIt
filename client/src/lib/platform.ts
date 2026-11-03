/**
 * 运行平台判断。只在确实要分平台的地方用（快捷键、标题栏、文案、更新通道等）。
 *
 * WKWebView（macOS）的 UA 带 "Macintosh"，WebView2（Windows）带 "Windows NT"。
 * 单测跑在 vitest 的 Node 环境里（UA 形如 "Node.js/22"），不会被判成 mac，
 * 所以现有单测默认按 Windows 行为跑。
 */
export const IS_MAC: boolean =
  typeof navigator !== 'undefined' && /Macintosh|Mac OS X/i.test(navigator.userAgent || '')
