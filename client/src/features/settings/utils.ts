import { matchRealEndpoint, realInputEndpoints, stripUsbIds } from '@/services/audio'
import type { MicEndpoint } from '@/services/audio'

export type { OverlayWaveTheme } from '@/lib/overlayWaveColors'

// 快捷键映射已收敛到 @/lib/shortcutKeys（单一数据源），这里透传导出以保持既有引用不变。
export {
  displayAccelerator,
  eventToAccelerator,
  getSingleKeyDisplay,
  keyEventToShortcutCandidate,
  resolveSingleKeyShortcut,
} from '@/lib/shortcutKeys'

export interface MicOption {
  value: string
  label: string
  /** 与 label 同一串。设备名常常长到被 truncate 截掉，而截掉的那段（USB 后缀）
   *  恰好是辨认设备的依据，所以完整名字必须能悬停看到。 */
  title: string
}

/** 只有 `default` 那条伪设备代表「系统默认」；`communications` 是通信用的另一路。 */
const SYSTEM_DEFAULT_PSEUDO_ID = 'default'

/**
 * 麦克风下拉的选项。第一项永远是「系统默认」（value 为空串）。
 *
 * 三条刻意的取舍：
 *
 * 1. **设备名保留型号，只剥掉 USB 标识。** 这里和悬浮窗那行提示的目标不同：悬浮窗是
 *    一瞬而过的确认，只要主名；这里是用户主动辨认设备的地方，括号里的型号
 *    （`Plantronics Blackwire 5220 Series`）必须留着，那是区分设备的依据。
 *    结尾的 `(047f:c053)` 例外 —— 见 stripUsbIds，它连同型号都区分不了。
 *    宽度不够时截断，完整名字放在 title 里。
 *
 * 2. **「系统默认」要写明它当前指向谁。** 光写「系统默认」等于没说，用户看不出录音会
 *    走哪个麦克风。Chromium 的 `default` 伪设备就携带这条信息（label 是
 *    `<本地化前缀> - <真实端点名>`、groupId 指向那个端点），用 matchRealEndpoint 落地。
 *
 * 3. **伪设备不单独成项。** 它们和第一项是同一件事的两种写法，列出来的话一个麦克风会
 *    占掉三四个选项，选哪个都一样却看着像不同设备。
 *
 * 选中的 deviceId 不在列表里时补一条占位项：不补的话 Select 找不到选中值，会退回占位符
 * 文案 —— 界面看起来像"没有选择麦克风"，而用户其实选过，也就无从知道该改什么。走到这里
 * 的真实场景是设备被拔掉、换了机器、清过 WebView 缓存（Chromium 的 deviceId 按 origin
 * 加盐，清掉之后全部变号）。刻意**不自动改回系统默认**：那会静默替掉用户的选择，
 * 这里只负责把状态说出来。
 */
export function buildMicOptions(
  devices: MicEndpoint[],
  selectedMic: string,
  labels: {
    systemDefault: string
    systemDefaultWith: (deviceName: string) => string
    unnamed: (idPrefix: string) => string
    unavailable: string
  },
): MicOption[] {
  const pseudoDefault = devices.find(
    (device) => device.deviceId.trim().toLowerCase() === SYSTEM_DEFAULT_PSEUDO_ID,
  )
  const resolvedDefault = pseudoDefault ? matchRealEndpoint(pseudoDefault, devices) : null
  const resolvedName = stripUsbIds(resolvedDefault?.label ?? '')

  const withTitle = (value: string, label: string): MicOption => ({ value, label, title: label })

  const options: MicOption[] = [
    withTitle('', resolvedName ? labels.systemDefaultWith(resolvedName) : labels.systemDefault),
    ...realInputEndpoints(devices).map((device) => withTitle(
      device.deviceId,
      // 设备名来自系统，不翻译；只有"读不到名字"时的兜底标签跟界面语言。
      stripUsbIds(device.label) || labels.unnamed(device.deviceId.slice(0, 8)),
    )),
  ]
  if (selectedMic && !options.some((option) => option.value === selectedMic)) {
    options.push(withTitle(selectedMic, labels.unavailable))
  }
  return options
}
