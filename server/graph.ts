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
  /** subsystem this node belongs to, drawn as a mermaid subgraph */
  group?: string
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
 * Diagrams stop at files: a scope shows the folders and files it contains, with
 * edges aggregated across everything beneath them. A file's own functions are
 * not diagrammed — dense intra-file call graphs read poorly and were the most
 * expensive views to lay out. A file's symbols and its callers/callees are
 * shown in the side panel instead, where they are a navigable list.
 *
 * A file scope resolves to its parent directory, so a stale link or cache entry
 * self-corrects rather than 404ing.
 */
export function project(
  ir: IR,
  scope: string,
  opts: { rootLabel?: string; maxNodes?: number; expand?: boolean } = {},
): View {
  const rootLabel = opts.rootLabel ?? 'root'
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES
  const dirScope = ir.files.some((f) => f.path === scope) ? parentOf(scope) : scope
  const view = projectDir(ir, dirScope)
  return {
    ...view,
    breadcrumbs: breadcrumbsFor(dirScope, rootLabel),
    ...capNodes(view.nodes, view.edges, maxNodes, opts.expand ?? false),
  }
}

function parentOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

type Partial_ = Pick<View, 'scope' | 'scopeKind' | 'nodes' | 'edges'>

/** A level with fewer entries than this is expanded a step deeper. */
const SPARSE_LEVEL = 6
/** …but never past this many nodes, or the view stops being readable. */
const SPARSE_EXPANDED_MAX = 24

/** The immediate children of a directory scope. */
function childrenOf(ir: IR, scope: string): ViewNode[] {
  const prefix = scope ? `${scope}/` : ''
  const nodes = new Map<string, ViewNode>()

  for (const file of ir.files) {
    if (prefix && !file.path.startsWith(prefix)) continue
    const rest = file.path.slice(prefix.length)
    if (!rest) continue
    const slash = rest.indexOf('/')
    const id = prefix + (slash === -1 ? rest : rest.slice(0, slash))

    const existing = nodes.get(id)
    if (existing) {
      if (existing.kind === 'folder') existing.count = (existing.count ?? 0) + 1
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
  return [...nodes.values()]
}

function projectDir(ir: IR, scope: string): Partial_ {
  const prefix = scope ? `${scope}/` : ''
  let nodes = childrenOf(ir, scope)

  // A folder like `src/` that holds one subfolder produces a level that looks
  // identical to the one before it, so clicking into it reads as "nothing
  // happened". When a level is this sparse, show a step deeper instead.
  if (nodes.length <= SPARSE_LEVEL) {
    const expanded: ViewNode[] = []
    for (const node of nodes) {
      const sub = node.kind === 'folder' ? childrenOf(ir, node.path) : []
      if (sub.length > 0 && expanded.length + sub.length <= SPARSE_EXPANDED_MAX) expanded.push(...sub)
      else expanded.push(node)
    }
    if (expanded.length > nodes.length) {
      // Labels stay relative to the scope, so the extra depth is visible.
      nodes = expanded.map((n) => ({ ...n, label: n.path.slice(prefix.length) }))
    }
  }

  // Longest-prefix match, so bucketing works whatever depth each node sits at.
  const byLength = [...nodes].sort((a, b) => b.path.length - a.path.length)
  const bucketOf = (filePath: string): string | undefined =>
    byLength.find((n) => filePath === n.path || filePath.startsWith(`${n.path}/`))?.id

  const edges = aggregate(ir, (id) => bucketOf(fileOf(id)))
  return { scope, scopeKind: 'dir', nodes: nodes.sort(byKindThenLabel), edges }
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
