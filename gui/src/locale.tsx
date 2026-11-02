import {createContext, useContext, useMemo, type ReactNode} from 'react'
import type {Language} from './types'
import {english} from './translations'

export type Translator = (text: string, values?: Record<string, string | number | undefined>) => string
const reverse = new Map(Object.entries(english).map(([source, target]) => [target, source]))
const singular: Record<string, string> = {'{0} 个子状态':'{0} child state','{0} 个节点':'{0} node','{0} 项待处理':'{0} issue to resolve','{0} 条跨层转换':'{0} cross-level transition'}
const patterns = Object.entries(english).filter(([source]) => /\{\w+\}/.test(source)).flatMap(([source, target]) => {
  const compile = (text: string) => {
    const keys: string[] = []
    const expression = text.split(/(\{\w+\})/g).map(part => {
      if (/^\{\w+\}$/.test(part)) {keys.push(part.slice(1, -1)); return '([\\s\\S]*?)'}
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }).join('')
    return {pattern: new RegExp('^' + expression + '$'), keys}
  }
  return [{...compile(source), source, target}, {...compile(target), source, target}, ...(singular[source] ? [{...compile(singular[source]),source,target}] : [])]
})
export function translator(language: Language): Translator {
  return (text, values) => {
    if (!text) return text
    const key = text.trim(), source = reverse.get(key) || key
    let result = language === 'en' ? (Number(values?.['0'])===1 && singular[source] ? singular[source] : english[source]) || key : source
    if (!values && !english[source] && !reverse.has(key)) {
      for (const entry of patterns) {
        const match = entry.pattern.exec(key)
        if (!match) continue
        const captured = Object.fromEntries(entry.keys.map((name, index) => [name, match[index + 1]]))
        result = (language === 'en' ? entry.target : entry.source).replace(/\{(\w+)\}/g, (token, name) => captured[name] ?? token)
        break
      }
    }
    if (values) result = result.replace(/\{(\w+)\}/g, (token, name) => String(values[name] ?? ''))
    return (text.match(/^\s+/)?.[0] || '') + result + (text.match(/\s+$/)?.[0] || '')
  }
}
const LocaleContext = createContext<{language: Language; t: Translator}>({language: 'zh', t: translator('zh')})
export function LocaleProvider({language, children}: {language: Language; children: ReactNode}) {
  const value = useMemo(() => ({language, t: translator(language)}), [language])
  return <LocaleContext value={value}>{children}</LocaleContext>
}
export const useLocale = () => useContext(LocaleContext)
