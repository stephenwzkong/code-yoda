export type Lang = 'ts' | 'js' | 'py'

export type SymbolKind = 'function' | 'method' | 'class'

export interface SymbolInfo {
  /** `${path}#${name}` — stable across runs, used as a graph node id */
  id: string
  name: string
  kind: SymbolKind
  line: number
  endLine: number
  doc?: string
  /** id of the enclosing class symbol, for methods */
  parent?: string
}

export interface FileInfo {
  /** repo-relative, posix separators */
  path: string
  lang: Lang
  symbols: SymbolInfo[]
}

export type EdgeKind = 'import' | 'call'
export type Confidence = 'resolved' | 'heuristic'

export interface Edge {
  /** symbol id for call edges, file path for import edges */
  from: string
  to: string
  kind: EdgeKind
  confidence: Confidence
}

export interface IR {
  root: string
  files: FileInfo[]
  edges: Edge[]
}

/** What an analyzer returns for the subset of files it owns. */
export type IRFragment = Pick<IR, 'files' | 'edges'>

export const LANG_BY_EXT: Record<string, Lang> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'py',
  '.pyi': 'py',
}

/** Split a node id into its file path and optional symbol name. */
export function splitId(id: string): { path: string; name?: string } {
  const hash = id.indexOf('#')
  return hash === -1 ? { path: id } : { path: id.slice(0, hash), name: id.slice(hash + 1) }
}

export function fileOf(id: string): string {
  return splitId(id).path
}
