import type { Confidence, EdgeKind, IR, Lang } from './types.ts'
import { fileOf } from './types.ts'

export type NodeKind =
  | 'folder'
  | 'file'
  | 'function'
  | 'method'
  | 'class'
  | 'variable'
  | 'module'
  | 'external'
  | 'more'

export interface ViewNode {
  id: string
  label: string
  kind: NodeKind
  lang?: Lang
  /** repo-relative path this node lives in (a folder path for folders) */
  path: string
  /** set for symbol nodes; the id to fetch source for */
  symbolId?: string
  line?: number
  /** files under a folder, or symbols in a file — shown as a subtitle */
  count?: number
  /** for the `more` node: how many nodes it stands in for */
  hidden?: number
}

export interface ViewEdge {
  from: string
  to: string
  kind: EdgeKind
  count: number
  confidence: Confidence
}

export interface View {
  scope: string
  scopeKind: 'dir' | 'file'
  breadcrumbs: Array<{ label: string; scope: string }>
  nodes: ViewNode[]
  edges: ViewEdge[]
  /** true when low-degree nodes were folded into a `more` node */
  collapsed: boolean
}

export const DEFAULT_MAX_NODES = 60

export function breadcrumbsFor(scope: string, rootLabel: string): Array<{ label: string; scope: string }> {
  const crumbs = [{ label: rootLabel, scope: '' }]
  if (!scope) return crumbs
  const parts = scope.split('/')
  parts.forEach((part, i) => crumbs.push({ label: part, scope: parts.slice(0, i + 1).join('/') }))
  return crumbs
}

/**
 * Projects the IR into a single readable level.
 *
 * A dir scope shows immediate children (subfolders collapsed, files expanded)
 * with edges aggregated across everything beneath them. A file scope shows that
 * file's symbols, plus stub nodes for calls crossing the file boundary.
 */
export function project(
  ir: IR,
  scope: string,
  opts: { rootLabel?: string; maxNodes?: number; expand?: boolean } = {},
): View {
  const rootLabel = opts.rootLabel ?? 'root'
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES
  const isFile = ir.files.some((f) => f.path === scope)
  const view = isFile ? projectFile(ir, scope) : projectDir(ir, scope)
  return {
    ...view,
    breadcrumbs: breadcrumbsFor(scope, rootLabel),
    ...capNodes(view.nodes, view.edges, maxNodes, opts.expand ?? false),
  }
}

type Partial_ = Pick<View, 'scope' | 'scopeKind' | 'nodes' | 'edges'>

function projectDir(ir: IR, scope: string): Partial_ {
  const prefix = scope ? `${scope}/` : ''
  const nodes = new Map<string, ViewNode>()

  /** Which node at this level does a file belong to? */
  const bucketOf = (filePath: string): string | undefined => {
    if (prefix && !filePath.startsWith(prefix)) return undefined
    const rest = filePath.slice(prefix.length)
    if (!rest) return undefined
    const slash = rest.indexOf('/')
    return prefix + (slash === -1 ? rest : rest.slice(0, slash))
  }

  for (const file of ir.files) {
    const id = bucketOf(file.path)
    if (!id) continue
    const existing = nodes.get(id)
    if (existing) {
      existing.count = (existing.count ?? 0) + (existing.kind === 'folder' ? 1 : 0)
      continue
    }
    const isFolder = id !== file.path
    nodes.set(id, {
      id,
      label: id.slice(prefix.length),
      kind: isFolder ? 'folder' : 'file',
      lang: isFolder ? undefined : file.lang,
      path: id,
      count: isFolder ? 1 : file.symbols.length,
    })
  }

  const edges = aggregate(ir, (id) => bucketOf(fileOf(id)))
  return { scope, scopeKind: 'dir', nodes: [...nodes.values()].sort(byKindThenLabel), edges }
}

function projectFile(ir: IR, scope: string): Partial_ {
  const file = ir.files.find((f) => f.path === scope)!
  const nodes = new Map<string, ViewNode>()
  const inFile = new Set(file.symbols.map((s) => s.id))

  for (const sym of file.symbols) {
    nodes.set(sym.id, {
      id: sym.id,
      label: sym.name,
      kind: sym.kind,
      lang: file.lang,
      path: file.path,
      symbolId: sym.id,
      line: sym.line,
    })
  }

  const edges: ViewEdge[] = []
  const seen = new Map<string, ViewEdge>()

  /** Calls that start or end at module scope are attributed to the file itself. */
  const ensureModuleNode = () => {
    if (nodes.has(file.path)) return
    nodes.set(file.path, {
      id: file.path,
      label: '(module scope)',
      kind: 'module',
      lang: file.lang,
      path: file.path,
      line: 1,
    })
  }

  const ensureExternal = (id: string) => {
    if (nodes.has(id)) return
    const owner = fileOf(id)
    const sym = ir.files.find((f) => f.path === owner)?.symbols.find((s) => s.id === id)
    const base = owner.split('/').pop() ?? owner
    nodes.set(id, {
      id,
      label: sym ? `${sym.name}\n${base}` : base,
      kind: 'external',
      path: owner,
      symbolId: sym ? id : undefined,
      line: sym?.line,
    })
  }

  const push = (edge: ViewEdge) => {
    const key = `${edge.from} ${edge.to} ${edge.kind}`
    const prior = seen.get(key)
    if (prior) {
      prior.count += edge.count
      if (edge.confidence === 'resolved') prior.confidence = 'resolved'
      return
    }
    seen.set(key, edge)
    edges.push(edge)
  }

  for (const e of ir.edges) {
    if (e.kind === 'import') continue // imports are a file-level relationship
    const fromHere = inFile.has(e.from) || e.from === file.path
    const toHere = inFile.has(e.to) || e.to === file.path
    if (!fromHere && !toHere) continue
    if (e.from === file.path || e.to === file.path) ensureModuleNode()
    if (!fromHere) ensureExternal(e.from)
    if (!toHere) ensureExternal(e.to)
    push({ from: e.from, to: e.to, kind: 'call', count: 1, confidence: e.confidence })
  }

  return { scope, scopeKind: 'file', nodes: [...nodes.values()].sort(byKindThenLabel), edges }
}

function aggregate(ir: IR, bucketOf: (id: string) => string | undefined): ViewEdge[] {
  const merged = new Map<string, ViewEdge>()
  for (const e of ir.edges) {
    const from = bucketOf(e.from)
    const to = bucketOf(e.to)
    if (!from || !to || from === to) continue
    const key = `${from} ${to}`
    const prior = merged.get(key)
    if (prior) {
      prior.count++
      // A folder-to-folder relationship reads as a call if any underlying edge is one.
      if (e.kind === 'call') prior.kind = 'call'
      if (e.confidence === 'resolved') prior.confidence = 'resolved'
      continue
    }
    merged.set(key, { from, to, kind: e.kind, count: 1, confidence: e.confidence })
  }
  return [...merged.values()].sort((a, b) => b.count - a.count)
}

function byKindThenLabel(a: ViewNode, b: ViewNode): number {
  const order: NodeKind[] = [
    'folder',
    'file',
    'module',
    'class',
    'variable',
    'function',
    'method',
    'external',
    'more',
  ]
  const diff = order.indexOf(a.kind) - order.indexOf(b.kind)
  return diff !== 0 ? diff : a.label.localeCompare(b.label)
}

/**
 * Keeps the view readable: past `maxNodes`, the least-connected nodes fold into
 * a single `+N more` node that the UI can expand on click.
 */
function capNodes(
  nodes: ViewNode[],
  edges: ViewEdge[],
  maxNodes: number,
  expand: boolean,
): { nodes: ViewNode[]; edges: ViewEdge[]; collapsed: boolean } {
  if (expand || nodes.length <= maxNodes) return { nodes, edges, collapsed: false }

  const degree = new Map<string, number>()
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + e.count)
    degree.set(e.to, (degree.get(e.to) ?? 0) + e.count)
  }

  const keep = [...nodes]
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) || a.label.localeCompare(b.label))
    .slice(0, maxNodes - 1)
  const keepIds = new Set(keep.map((n) => n.id))
  const hiddenCount = nodes.length - keepIds.size

  const kept = nodes.filter((n) => keepIds.has(n.id))
  kept.push({
    id: '__more__',
    label: `+${hiddenCount} more`,
    kind: 'more',
    path: '',
    hidden: hiddenCount,
  })

  return {
    nodes: kept,
    edges: edges.filter((e) => keepIds.has(e.from) && keepIds.has(e.to)),
    collapsed: true,
  }
}
