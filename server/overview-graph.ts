import type { View, ViewEdge, ViewNode } from './graph.ts'
import type { RepoGroup } from './llm.ts'
import { fileOf, type IR } from './types.ts'

/**
 * One whole-repo poster: every subsystem drawn as a labelled box holding its
 * most-connected files, with the dependencies between subsystems.
 *
 * This is deliberately a single diagram rather than a level to drill through.
 * The grouping costs a model call, but once it is rendered there is nothing
 * left to lay out — no second level, no per-click latency.
 *
 * Claude supplies only the grouping and the names. Nodes are real files and
 * edges come from the analyzers, so every node opens real source.
 */

/** Files shown inside each subsystem box. Enough to recognise it, few enough to read. */
const FILES_PER_GROUP = 5

export function projectOverview(ir: IR, groups: RepoGroup[]): View {
  const groupOf = new Map<string, string>()
  for (const g of groups) for (const path of g.paths) groupOf.set(path, g.name)

  const degree = fileDegrees(ir)

  const nodes: ViewNode[] = []
  for (const group of groups) {
    const shown = [...group.paths]
      .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || a.localeCompare(b))
      .slice(0, FILES_PER_GROUP)

    for (const path of shown) {
      const file = ir.files.find((f) => f.path === path)
      nodes.push({
        id: path,
        label: path.split('/').pop() ?? path,
        kind: 'file',
        lang: file?.lang,
        path,
        count: file?.symbols.length,
        group: group.name,
      })
    }

    const hidden = group.paths.length - shown.length
    if (hidden > 0) {
      nodes.push({
        id: `more:${group.name}`,
        label: `+${hidden} more`,
        kind: 'more',
        path: '',
        hidden,
        group: group.name,
      })
    }
  }

  return {
    scope: '',
    scopeKind: 'dir',
    breadcrumbs: [{ label: 'Whole repository', scope: '' }],
    nodes,
    edges: betweenGroups(ir, groupOf),
    collapsed: false,
  }
}

/** How connected each file is, so the poster shows each subsystem's hubs. */
function fileDegrees(ir: IR): Map<string, number> {
  const degree = new Map<string, number>()
  for (const edge of ir.edges) {
    const from = fileOf(edge.from)
    const to = fileOf(edge.to)
    if (from === to) continue
    degree.set(from, (degree.get(from) ?? 0) + 1)
    degree.set(to, (degree.get(to) ?? 0) + 1)
  }
  return degree
}

/**
 * Subsystem-to-subsystem dependencies, drawn between the boxes themselves so
 * the poster shows architecture rather than a mesh of individual files.
 */
function betweenGroups(ir: IR, groupOf: Map<string, string>): ViewEdge[] {
  const merged = new Map<string, ViewEdge>()
  for (const e of ir.edges) {
    const from = groupOf.get(fileOf(e.from))
    const to = groupOf.get(fileOf(e.to))
    if (!from || !to || from === to) continue
    const key = `${from} ${to}`
    const prior = merged.get(key)
    if (prior) {
      prior.count++
      if (e.kind === 'call') prior.kind = 'call'
      if (e.confidence === 'resolved') prior.confidence = 'resolved'
      continue
    }
    merged.set(key, {
      from: `group:${from}`,
      to: `group:${to}`,
      kind: e.kind,
      count: 1,
      confidence: e.confidence,
    })
  }
  return [...merged.values()].sort((a, b) => b.count - a.count)
}
