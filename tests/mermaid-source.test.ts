import { describe, expect, it } from 'vitest'
import type { View } from '../server/graph.ts'
import { buildDiagram, nodeKeyFrom } from '../src/mermaid-source.ts'

const view: View = {
  scope: 'src',
  scopeKind: 'dir',
  breadcrumbs: [],
  collapsed: false,
  nodes: [
    { id: 'src/a.ts', label: 'a.ts', kind: 'file', lang: 'ts', path: 'src/a.ts', count: 3 },
    { id: 'src/b.py', label: 'b.py', kind: 'file', lang: 'py', path: 'src/b.py', count: 0 },
    { id: 'src/api', label: 'api', kind: 'folder', path: 'src/api', count: 4 },
    { id: 'src/a.ts#Thing', label: 'Thing', kind: 'class', lang: 'ts', path: 'src/a.ts' },
    { id: '__more__', label: '+9 more', kind: 'more', path: '', hidden: 9 },
  ],
  edges: [
    { from: 'src/a.ts', to: 'src/api', kind: 'import', count: 1, confidence: 'resolved' },
    { from: 'src/api', to: 'src/b.py', kind: 'call', count: 4, confidence: 'heuristic' },
  ],
}

describe('buildDiagram', () => {
  const { source, nodeById } = buildDiagram(view)

  it('maps mermaid aliases back to view nodes', () => {
    expect(nodeById.get('n0')?.id).toBe('src/a.ts')
    expect(nodeById.get('n4')?.kind).toBe('more')
  })

  it('gives each kind its own shape and style class', () => {
    expect(source).toContain('n0["a.ts<br/><small>3</small>"]')
    expect(source).toContain('n2("api<br/><small>4</small>")')
    expect(source).toContain('n3{{"Thing"}}')
    expect(source).toContain('class n0 k-file-ts')
    expect(source).toContain('class n1 k-file-py')
  })

  it('omits a zero symbol count rather than printing "0"', () => {
    expect(source).toContain('n1["b.py"]')
  })

  it('draws heuristic edges dashed and labels aggregated counts', () => {
    expect(source).toContain('n0 --> n2')
    expect(source).toContain('n2 -. 4 .-> n1')
  })

  it('escapes label text before adding its own markup', () => {
    const { source: escaped } = buildDiagram({
      ...view,
      nodes: [{ id: 'x', label: '<img src=x> "q"', kind: 'file', path: 'x' }],
      edges: [],
    })
    expect(escaped).toContain('&lt;img src=x&gt; &quot;q&quot;')
    expect(escaped).not.toContain('<img')
  })
})

describe('nodeKeyFrom', () => {
  // Mermaid prefixes rendered node ids with the diagram id; missing that prefix
  // silently detaches every click handler, so pin the format down here.
  it('recovers our alias from a rendered mermaid node id', () => {
    expect(nodeKeyFrom('yoda-2-flowchart-n0-0')).toBe('n0')
    expect(nodeKeyFrom('flowchart-n12-7')).toBe('n12')
  })

  it('ignores ids that are not mermaid nodes', () => {
    expect(nodeKeyFrom('')).toBeUndefined()
    expect(nodeKeyFrom('some-other-element')).toBeUndefined()
  })
})
