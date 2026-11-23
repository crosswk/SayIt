// 语音翻译的目标语言。
//
// 只存 BCP 47 代码，显示名一律用 Intl.DisplayNames 现算：五十多种语言 × 两份界面语言
// 写进 locale 文件既占地方又容易漏，而浏览器（WebView2 / WKWebView）自带的这份是准的。
// 交给模型的语言名用「英文名 (本地名)」，任何模型都认得，也不会把繁简、葡语的地区弄混。

export const TRANSLATE_LANGUAGE_CODES = [
  'en', 'zh-Hans', 'zh-Hant', 'yue', 'ja', 'ko',
  'fr', 'de', 'es', 'pt-BR', 'pt-PT', 'it', 'ru',
  'ar', 'hi', 'bn', 'ur', 'id', 'ms', 'th', 'vi', 'fil',
  'tr', 'fa', 'he', 'pl', 'nl', 'sv', 'nb', 'da', 'fi',
  'el', 'cs', 'sk', 'hu', 'ro', 'bg', 'uk', 'hr', 'sr', 'sl',
  'lt', 'lv', 'et', 'sw', 'ta', 'te', 'mr', 'gu', 'pa', 'kn', 'ml',
  'my', 'km', 'lo', 'mn', 'ne',
] as const

export type TranslateLanguageCode = typeof TRANSLATE_LANGUAGE_CODES[number]

export const DEFAULT_TRANSLATE_LANGUAGE: TranslateLanguageCode = 'en'

export function normalizeTranslateLanguage(value: unknown): TranslateLanguageCode {
  return (TRANSLATE_LANGUAGE_CODES as readonly string[]).includes(value as string)
    ? value as TranslateLanguageCode
    : DEFAULT_TRANSLATE_LANGUAGE
}

/** 用 `displayLocale` 的写法给出 `code` 的名字；运行时不支持时退回代码本身。 */
export function languageName(code: string, displayLocale: string): string {
  try {
    const name = new Intl.DisplayNames([displayLocale], { type: 'language' }).of(code)
    return name && name !== code ? name : code
  } catch {
    return code
  }
}

/** 该语言自己的写法（日本語、Deutsch）。 */
export function nativeLanguageName(code: string): string {
  return languageName(code, code)
}

/** 交给模型的名字：英文名 + 本地名，两者相同时只写一个。 */
export function languageNameForPrompt(code: string): string {
  const english = languageName(code, 'en')
  const native = nativeLanguageName(code)
  return native && native !== english ? `${english} (${native})` : english
}
