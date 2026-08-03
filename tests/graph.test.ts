import { describe, expect, it } from 'vitest'
import { breadcrumbsFor, project } from '../server/graph.ts'
import type { IR } from '../server/types.ts'

const ir: IR = {
  root: '/repo',
  files: [
    {
      path: 'src/api/handlers.ts',
      lang: 'ts',
      symbols: [
        { id: 'src/api/handlers.ts#handle', name: 'handle', kind: 'function', line: 3, endLine: 9 },
        { id: 'src/api/handlers.ts#parse', name: 'parse', kind: 'function', line: 11, endLine: 14 },
      ],
    },
    {
      path: 'src/api/routes.ts',
      lang: 'ts',
      symbols: [{ id: 'src/api/routes.ts#register', name: 'register', kind: 'function', line: 2, endLine: 8 }],
    },
    {
      path: 'lib/util.py',
      lang: 'py',
      symbols: [{ id: 'lib/util.py#slugify', name: 'slugify', kind: 'function', line: 1, endLine: 4 }],
    },
  ],
  edges: [
    { from: 'src/api/routes.ts', to: 'src/api/handlers.ts', kind: 'import', confidence: 'resolved' },
    { from: 'src/api/routes.ts#register', to: 'src/api/handlers.ts#handle', kind: 'call', confidence: 'resolved' },
    { from: 'src/api/handlers.ts#handle', to: 'src/api/handlers.ts#parse', kind: 'call', confidence: 'resolved' },
    { from: 'src/api/handlers.ts#handle', to: 'lib/util.py#slugify', kind: 'call', confidence: 'heuristic' },
    { from: 'src/api/handlers.ts', to: 'src/api/handlers.ts#handle', kind: 'call', confidence: 'resolved' },
  ],
}

describe('root scope', () => {
  const view = project(ir, '')

  it('shows top-level folders, not files', () => {
    expect(view.nodes.map((n) => n.id).sort()).toEqual(['lib', 'src'])
    expect(view.nodes.every((n) => n.kind === 'folder')).toBe(true)
  })

  it('aggregates every underlying edge between two folders', () => {
    const edge = view.edges.find((e) => e.from === 'src' && e.to === 'lib')
    expect(edge).toMatchObject({ count: 1, confidence: 'heuristic' })
    // src -> src edges are internal at this level and must not appear.
    expect(view.edges.some((e) => e.from === e.to)).toBe(false)
  })
})

describe('directory scope', () => {
  const view = project(ir, 'src/api')

  it('expands files inside the scope with their symbol counts', () => {
    expect(view.nodes.map((n) => ({ id: n.id, kind: n.kind, count: n.count }))).toEqual(
      expect.arrayContaining([
        { id: 'src/api/handlers.ts', kind: 'file', count: 2 },
        { id: 'src/api/routes.ts', kind: 'file', count: 1 },
      ]),
    )
  })

  it('keeps file-to-file edges and drops out-of-scope ones', () => {
    expect(view.edges).toHaveLength(1)
    expect(view.edges[0]).toMatchObject({ from: 'src/api/routes.ts', to: 'src/api/handlers.ts', count: 2 })
  })
})

describe('file scope', () => {
  const view = project(ir, 'src/api/handlers.ts')

  it('shows the file symbols', () => {
    expect(view.scopeKind).toBe('file')
    expect(view.nodes.filter((n) => n.kind === 'function').map((n) => n.label).sort()).toEqual([
      'handle',
      'parse',
    ])
  })

  it('adds a module-scope node for top-level calls', () => {
    expect(view.nodes.find((n) => n.kind === 'module')?.label).toBe('(module scope)')
  })

  it('stubs symbols on the other side of the file boundary', () => {
    const external = view.nodes.filter((n) => n.kind === 'external').map((n) => n.id)
    expect(external).toEqual(expect.arrayContaining(['src/api/routes.ts#register', 'lib/util.py#slugify']))
  })

  it('preserves heuristic confidence so the UI can dash the edge', () => {
    const guess = view.edges.find((e) => e.to === 'lib/util.py#slugify')
    expect(guess?.confidence).toBe('heuristic')
  })

  it('omits import edges, which are a file-level relationship', () => {
    expect(view.edges.every((e) => e.kind === 'call')).toBe(true)
  })
})

describe('node cap', () => {
  const big: IR = {
    root: '/repo',
    files: Array.from({ length: 40 }, (_, i) => ({
      path: `pkg/f${i}.py`,
      lang: 'py' as const,
      symbols: [],
    })),
    edges: [{ from: 'pkg/f0.py', to: 'pkg/f1.py', kind: 'import' as const, confidence: 'resolved' as const }],
  }

  it('folds low-degree nodes into a single expandable node', () => {
    const view = project(big, 'pkg', { maxNodes: 10 })
    expect(view.collapsed).toBe(true)
    expect(view.nodes).toHaveLength(10)
    const more = view.nodes.find((n) => n.kind === 'more')
    expect(more?.hidden).toBe(31)
    // The connected pair survives the cull.
    expect(view.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['pkg/f0.py', 'pkg/f1.py']))
  })

  it('shows everything when expanded', () => {
    const view = project(big, 'pkg', { maxNodes: 10, expand: true })
    expect(view.collapsed).toBe(false)
    expect(view.nodes).toHaveLength(40)
  })
})

describe('breadcrumbs', () => {
  it('walks from the repo label down to the current scope', () => {
    expect(breadcrumbsFor('src/api/handlers.ts', 'my-repo')).toEqual([
      { label: 'my-repo', scope: '' },
      { label: 'src', scope: 'src' },
      { label: 'api', scope: 'src/api' },
      { label: 'handlers.ts', scope: 'src/api/handlers.ts' },
    ])
  })
})
