import type { View, ViewEdge, ViewNode } from '../server/graph.ts'

/** Mermaid node ids must be simple, so we mint `n0, n1, …` and keep a lookup. */
export interface Diagram {
  source: string
  nodeById: Map<string, ViewNode>
}

/** Labels come from file and symbol names, so escape before we add our own markup. */
function escapeLabel(label: string): string {
  return label
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br/>')
}

function shape(alias: string, node: ViewNode): string {
  const sub = node.count ? `<br/><small>${node.count}</small>` : ''
  const label = `"${escapeLabel(node.label)}${sub}"`
  switch (node.kind) {
    case 'folder':
      return `${alias}(${label})`
    case 'file':
      return `${alias}[${label}]`
    case 'class':
      return `${alias}{{${label}}}`
    case 'module':
      return `${alias}[[${label}]]`
    case 'external':
      return `${alias}[/${label}/]`
    case 'more':
      return `${alias}>${label}]`
    default:
      return `${alias}([${label}])`
  }
}

function connector(edge: ViewEdge): string {
  // Heuristic edges are dashed: the graph must never present a guess as a fact.
  if (edge.count > 1) return edge.confidence === 'heuristic' ? `-. ${edge.count} .->` : `-- ${edge.count} -->`
  return edge.confidence === 'heuristic' ? '-.->' : '-->'
}

/** `class` and friends are mermaid keywords, so style classes carry a `k-` prefix. */
function styleClass(node: ViewNode): string {
  if (node.kind === 'file' && node.lang) return `k-file-${node.lang}`
  return `k-${node.kind}`
}

const CLASS_DEFS = [
  'classDef k-folder fill:#1f3a5f,stroke:#4a90d9,color:#e8f0fb',
  'classDef k-file-ts fill:#22303c,stroke:#4a90d9,color:#e6edf3',
  'classDef k-file-js fill:#33301c,stroke:#d0bb52,color:#f5f1df',
  'classDef k-file-py fill:#1e3440,stroke:#4b8bbe,color:#e6f1f7',
  'classDef k-file fill:#22303c,stroke:#5c7d99,color:#e6edf3',
  'classDef k-class fill:#3d2c4f,stroke:#a06fd0,color:#f2e9fb',
  'classDef k-function fill:#1e3a32,stroke:#4ec9a0,color:#e4f7f0',
  'classDef k-method fill:#1e3a32,stroke:#4ec9a0,color:#e4f7f0',
  'classDef k-module fill:#3a3320,stroke:#c9a94e,color:#f7f1e0',
  'classDef k-external fill:#2b2b2b,stroke:#777777,color:#cccccc',
  'classDef k-more fill:#402a2a,stroke:#d07070,color:#fbe9e9',
]

/**
 * Mermaid names rendered nodes `<diagramId>-flowchart-<ourId>-<n>`; recover our
 * id from that. Our ids are always `n<digits>`, which keeps the match unambiguous
 * even though the diagram id is arbitrary.
 */
export function nodeKeyFrom(elementId: string): string | undefined {
  return /flowchart-(n\d+)-\d+$/.exec(elementId)?.[1]
}

export function buildDiagram(view: View): Diagram {
  const alias = new Map<string, string>()
  const nodeById = new Map<string, ViewNode>()
  view.nodes.forEach((node, i) => {
    const key = `n${i}`
    alias.set(node.id, key)
    nodeById.set(key, node)
  })

  const lines = ['flowchart LR']
  for (const node of view.nodes) {
    const key = alias.get(node.id)!
    lines.push(`  ${shape(key, node)}`)
    lines.push(`  class ${key} ${styleClass(node)}`)
  }
  for (const edge of view.edges) {
    const from = alias.get(edge.from)
    const to = alias.get(edge.to)
    if (!from || !to) continue
    lines.push(`  ${from} ${connector(edge)} ${to}`)
  }
  for (const def of CLASS_DEFS) lines.push(`  ${def}`)

  return { source: lines.join('\n'), nodeById }
}
