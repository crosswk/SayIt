import type { CustomTheme } from './model'

export interface HotwordsState {
  hotwords: string[]
  builtinSetWords: Record<string, string[]>
  builtinSetActive: Record<string, boolean>
  customThemes: CustomTheme[]
  customThemeActive: Record<string, boolean>
  themeInputs: Record<string, string>
  newThemeName: string
  search: string
  loading: boolean
  showUnknown: boolean
}

export const initialHotwordsState: HotwordsState = {
  hotwords: [],
  builtinSetWords: {},
  builtinSetActive: {},
  customThemes: [],
  customThemeActive: {},
  themeInputs: {},
  newThemeName: '',
  search: '',
  loading: true,
  showUnknown: false,
}

export type HotwordsAction =
  | { type: 'set_loading'; value: boolean }
  | { type: 'set_search'; value: string }
  | { type: 'set_show_unknown'; value: boolean }
  | { type: 'set_new_theme_name'; value: string }
  | { type: 'set_theme_input'; themeId: string; value: string }
  | { type: 'set_snapshot'; payload: Partial<HotwordsState> }

export function hotwordsReducer(state: HotwordsState, action: HotwordsAction): HotwordsState {
  switch (action.type) {
    case 'set_loading':
      return { ...state, loading: action.value }
    case 'set_search':
      return { ...state, search: action.value }
    case 'set_show_unknown':
      return { ...state, showUnknown: action.value }
    case 'set_new_theme_name':
      return { ...state, newThemeName: action.value }
    case 'set_theme_input':
      return {
        ...state,
        themeInputs: { ...state.themeInputs, [action.themeId]: action.value },
      }
    case 'set_snapshot':
      return {
        ...state,
        ...action.payload,
      }
    default:
      return state
  }
}
