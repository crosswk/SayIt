/**
 * macOS 上让网页窗口的行为更像原生应用。只在 mac 的窗口入口里调用（main.tsx、overlay/main.tsx）。
 *
 * - 给 <html> 加上 `platform-mac`：index.css 里 mac 专属的样式（系统滚动条、界面文字不可选、
 *   按钮用箭头光标）都挂在这个 class 下，Windows 没有它，样式与原来完全一致。
 * - 右键菜单：WebKit 默认在空白处弹「重新载入」、在链接上弹「打开链接」（会把主窗口导航到外部
 *   网页）。只在输入框里、或者已经选中了文字时保留系统的右键菜单（剪切 / 拷贝 / 粘贴、查询、翻译）。
 */

/** 可编辑元素：右键要能剪切、拷贝、粘贴 */
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

interface ClosestCapable {
  closest(selector: string): unknown
}

function canQueryClosest(target: unknown): target is ClosestCapable {
  return typeof target === 'object' && target !== null
    && typeof (target as { closest?: unknown }).closest === 'function'
}

/** 这次右键要不要交给系统弹菜单。 */
export function shouldShowNativeContextMenu(target: EventTarget | null, selectedText: string): boolean {
  if (selectedText.trim().length > 0) return true
  if (!canQueryClosest(target)) return false
  return Boolean(target.closest(EDITABLE_SELECTOR))
}

let installed = false

export function installMacWebviewBehavior(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.documentElement.classList.add('platform-mac')
  window.addEventListener('contextmenu', (event) => {
    const selectedText = window.getSelection()?.toString() ?? ''
    if (!shouldShowNativeContextMenu(event.target, selectedText)) {
      event.preventDefault()
    }
  })
}
