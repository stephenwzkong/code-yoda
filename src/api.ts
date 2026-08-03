import type { View } from '../server/graph.ts'
import type { Lang, SymbolInfo } from '../server/types.ts'

export interface Meta {
  repoId: string
  label: string
  root: string
  origin: 'local' | 'github'
  fileCount: number
  symbolCount: number
  edgeCount: number
  langs: Record<string, number>
  warnings: string[]
  elapsedMs: number
  cached: boolean
}

export interface SymbolRef {
  id: string
  name: string
  path: string
  line: number
  confidence: 'resolved' | 'heuristic'
}

export interface SymbolDetail {
  symbol: SymbolInfo
  path: string
  abs: string
  lang: Lang
  code: string
  callers: SymbolRef[]
  callees: SymbolRef[]
}

export interface FileDetail {
  path: string
  abs: string
  lang: Lang
  code: string
  symbols: SymbolInfo[]
}

export interface SearchHit {
  id: string
  name: string
  path: string
  kind: string
  line: number
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const body = await res.json()
  if (!res.ok) throw new Error(body?.error ?? `Request failed (${res.status})`)
  return body as T
}

export function analyzeSource(source: string): Promise<Meta> {
  return fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  }).then(async (res) => {
    const body = await res.json()
    if (!res.ok) throw new Error(body?.error ?? 'Analysis failed')
    return body as Meta
  })
}

export function fetchView(repoId: string, scope: string, expand = false): Promise<View> {
  const params = new URLSearchParams({ repoId, scope })
  if (expand) params.set('expand', '1')
  return get<View>(`/api/view?${params}`)
}

export function fetchSymbol(repoId: string, id: string): Promise<SymbolDetail> {
  return get<SymbolDetail>(`/api/symbol?${new URLSearchParams({ repoId, id })}`)
}

export function fetchFile(repoId: string, path: string): Promise<FileDetail> {
  return get<FileDetail>(`/api/source?${new URLSearchParams({ repoId, path })}`)
}

export function search(repoId: string, q: string): Promise<SearchHit[]> {
  return get<SearchHit[]>(`/api/search?${new URLSearchParams({ repoId, q })}`)
}
