import type { View, ViewEdge, ViewNode } from './graph.ts'
import type { RepoGroup } from './llm.ts'
import { fileOf, type IR } from './types.ts'

/**
 * Turns Claude's groupings into the same `View` the deterministic projection
 * produces, so the chart, click handling and side panel work unchanged.
 *
 * The model supplies only the grouping and the names. Nodes are real files and
 * edges are the ones the analyzers resolved — nothing here is model-authored.
 */
export function projectOverview(ir: IR, groups: RepoGroup[], group?: string): View {
  return group ? filesInGroup(ir, groups, group) : subsystems(ir, groups)
}

/** Top level: one node per subsystem, edges aggregated between them. */
function subsystems(ir: IR, groups: RepoGroup[]): View {
  const groupOf = new Map<string, string>()
  for (const g of groups) for (const path of g.paths) groupOf.set(path, g.name)

  const nodes: ViewNode[] = groups.map((g) => ({
    id: `group:${g.name}`,
    label: g.name,
    kind: 'folder',
    path: `group:${g.name}`,
    count: g.paths.length,
  }))

  const edges = aggregate(ir, (path) => {
    const name = groupOf.get(path)
    return name ? `group:${name}` : undefined
  })

  return {
    scope: '',
    scopeKind: 'dir',
    breadcrumbs: [{ label: 'Subsystems', scope: '' }],
    nodes,
    edges,
    collapsed: false,
  }
}

/** Second level: the files in one subsystem, with the edges between them. */
function filesInGroup(ir: IR, groups: RepoGroup[], groupId: string): View {
  const name = groupId.replace(/^group:/, '')
  const group = groups.find((g) => g.name === name)
  const paths = new Set(group?.paths ?? [])

  const nodes: ViewNode[] = ir.files
    .filter((f) => paths.has(f.path))
    .map((f) => ({
      id: f.path,
      label: f.path,
      kind: 'file',
      lang: f.lang,
      path: f.path,
      count: f.symbols.length,
    }))

  const edges = aggregate(ir, (path) => (paths.has(path) ? path : undefined))

  return {
    scope: groupId,
    scopeKind: 'dir',
    breadcrumbs: [
      { label: 'Subsystems', scope: '' },
      { label: name, scope: groupId },
    ],
    nodes,
    edges,
    collapsed: false,
  }
}

function aggregate(ir: IR, bucketOf: (path: string) => string | undefined): ViewEdge[] {
  const merged = new Map<string, ViewEdge>()
  for (const e of ir.edges) {
    const from = bucketOf(fileOf(e.from))
    const to = bucketOf(fileOf(e.to))
    if (!from || !to || from === to) continue
    const key = `${from} ${to}`
    const prior = merged.get(key)
    if (prior) {
      prior.count++
      if (e.kind === 'call') prior.kind = 'call'
      if (e.confidence === 'resolved') prior.confidence = 'resolved'
      continue
    }
    merged.set(key, { from, to, kind: e.kind, count: 1, confidence: e.confidence })
  }
  return [...merged.values()].sort((a, b) => b.count - a.count)
}
