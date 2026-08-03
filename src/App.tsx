import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewNode } from '../server/graph.ts'
import { analyzeSource, fetchFile, fetchSymbol, search, type Meta, type SearchHit } from './api.ts'
import { Breadcrumbs } from './Breadcrumbs.tsx'
import { ChartPane } from './ChartPane.tsx'
import {
  invalidateRepo,
  loadDiagram,
  peek,
  prefetchChildren,
  warmUp,
  type Diagram,
} from './diagram-cache.ts'
import { SidePanel, type Selection } from './SidePanel.tsx'

const LAST_SOURCE_KEY = 'code-yoda:last-source'

export function App() {
  const [sourceInput, setSourceInput] = useState(() => localStorage.getItem(LAST_SOURCE_KEY) ?? '')
  const [meta, setMeta] = useState<Meta | null>(null)
  const [scope, setScope] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [diagram, setDiagram] = useState<Diagram | null>(null)
  const [chartPending, setChartPending] = useState(false)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>()
  const [analyzing, setAnalyzing] = useState(false)
  const [panelLoading, setPanelLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [hits, setHits] = useState<SearchHit[]>([])
  const [query, setQuery] = useState('')
  const [panelWidth, setPanelWidth] = useState(520)
  const resizing = useRef(false)

  const runAnalysis = useCallback(async () => {
    setAnalyzing(true)
    setError(null)
    try {
      const result = await analyzeSource(sourceInput)
      localStorage.setItem(LAST_SOURCE_KEY, sourceInput)
      // The repo may have changed on disk since we last rendered it.
      invalidateRepo(result.repoId)
      setMeta(result)
      setScope('')
      setExpanded(false)
      setSelection(null)
      setSelectedNodeId(undefined)
    } catch (err) {
      setError((err as Error).message)
      setMeta(null)
      setDiagram(null)
    } finally {
      setAnalyzing(false)
    }
  }, [sourceInput])

  // Mermaid's engine warm-up is ~60ms; pay it while the empty state is on screen.
  useEffect(warmUp, [])

  // Load the diagram whenever the repo or scope changes, then render the levels
  // below it in the background so the next click has nothing left to compute.
  useEffect(() => {
    if (!meta) return
    let cancelled = false
    let stopPrefetch: (() => void) | undefined

    // A cached level swaps in synchronously — no spinner, no flash of emptiness.
    const cached = peek(meta.repoId, scope, expanded)
    if (cached) setDiagram(cached)
    else setChartPending(true)

    loadDiagram(meta.repoId, scope, expanded)
      .then((next) => {
        if (cancelled) return
        setDiagram(next)
        setError(null)
        stopPrefetch = prefetchChildren(meta.repoId, next.view)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setChartPending(false)
      })

    return () => {
      cancelled = true
      stopPrefetch?.()
    }
  }, [meta, scope, expanded])

  const openSymbol = useCallback(
    async (symbolId: string) => {
      if (!meta) return
      setPanelLoading(true)
      setPanelError(null)
      setSelectedNodeId(symbolId)
      try {
        setSelection({ kind: 'symbol', detail: await fetchSymbol(meta.repoId, symbolId) })
      } catch (err) {
        setSelection(null)
        setPanelError((err as Error).message)
      } finally {
        setPanelLoading(false)
      }
    },
    [meta],
  )

  const openFile = useCallback(
    async (path: string) => {
      if (!meta) return
      setPanelLoading(true)
      setPanelError(null)
      setSelectedNodeId(path)
      try {
        setSelection({ kind: 'file', detail: await fetchFile(meta.repoId, path) })
      } catch (err) {
        setSelection(null)
        setPanelError((err as Error).message)
      } finally {
        setPanelLoading(false)
      }
    },
    [meta],
  )

  const goTo = useCallback((next: string) => {
    setScope(next)
    setExpanded(false)
  }, [])

  const onNodeSelect = useCallback(
    (node: ViewNode) => {
      switch (node.kind) {
        case 'more':
          setExpanded(true)
          return
        case 'folder':
          goTo(node.path)
          return
        case 'file':
          // Files do both: drill the diagram in, and show the source alongside.
          goTo(node.path)
          void openFile(node.path)
          return
        case 'module':
          void openFile(node.path)
          return
        case 'external':
          if (node.symbolId) void openSymbol(node.symbolId)
          else void openFile(node.path)
          return
        default:
          if (node.symbolId) void openSymbol(node.symbolId)
      }
    },
    [goTo, openFile, openSymbol],
  )

  const onNodeHover = useCallback(
    (node: ViewNode) => {
      if (!meta || (node.kind !== 'folder' && node.kind !== 'file')) return
      void loadDiagram(meta.repoId, node.path).catch(() => undefined)
    },
    [meta],
  )

  // Debounced symbol search.
  useEffect(() => {
    if (!meta || query.trim().length < 2) {
      setHits([])
      return
    }
    const timer = setTimeout(() => {
      search(meta.repoId, query)
        .then(setHits)
        .catch(() => setHits([]))
    }, 150)
    return () => clearTimeout(timer)
  }, [meta, query])

  const onHit = (hit: SearchHit) => {
    setQuery('')
    setHits([])
    if (hit.kind === 'file') {
      goTo(hit.path)
      void openFile(hit.path)
    } else {
      goTo(hit.path)
      void openSymbol(hit.id)
    }
  }

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!resizing.current) return
      setPanelWidth(Math.min(Math.max(320, window.innerWidth - event.clientX), window.innerWidth - 360))
    }
    const stop = () => {
      resizing.current = false
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', stop)
    }
  }, [])

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">code&#8209;yoda</div>
        <form
          className="source-form"
          onSubmit={(event) => {
            event.preventDefault()
            void runAnalysis()
          }}
        >
          <input
            value={sourceInput}
            onChange={(event) => setSourceInput(event.target.value)}
            placeholder="/path/to/repo  or  https://github.com/owner/repo"
            spellCheck={false}
          />
          <button type="submit" disabled={analyzing || !sourceInput.trim()}>
            {analyzing ? 'Analyzing…' : 'Analyze'}
          </button>
        </form>
        {meta ? (
          <div className="search-box">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search files and symbols"
              spellCheck={false}
            />
            {hits.length > 0 ? (
              <ul className="search-results">
                {hits.map((hit) => (
                  <li key={`${hit.id}:${hit.line}`}>
                    <button onClick={() => onHit(hit)}>
                      <span className={`badge badge-${hit.kind}`}>{hit.kind}</span>
                      <span className="ref-name">{hit.name}</span>
                      <span className="ref-path">{hit.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {meta ? (
          <div className="repo-stats">
            {meta.fileCount} files · {meta.symbolCount} symbols · {meta.edgeCount} edges
            {meta.cached ? ' · cached' : ` · ${(meta.elapsedMs / 1000).toFixed(1)}s`}
          </div>
        ) : null}
      </header>

      {error ? <div className="banner error">{error}</div> : null}
      {meta?.warnings.map((warning) => (
        <div className="banner warn" key={warning}>
          {warning}
        </div>
      ))}

      <div className="workspace">
        <main className="main-pane">
          {diagram ? (
            <>
              <Breadcrumbs crumbs={diagram.view.breadcrumbs} onNavigate={goTo} />
              {chartPending ? <div className="chart-progress" /> : null}
              <ChartPane
                diagram={diagram}
                selectedId={selectedNodeId}
                onSelect={onNodeSelect}
                onHover={onNodeHover}
              />
            </>
          ) : chartPending ? (
            <div className="empty-state">
              <p>Laying out the diagram…</p>
            </div>
          ) : (
            <div className="empty-state">
              <h1>Visualize a codebase</h1>
              <p>Enter a local folder path or a GitHub URL above, then press Analyze.</p>
              <p className="muted">Python and JavaScript/TypeScript are supported.</p>
            </div>
          )}
        </main>
        <div className="resizer" onMouseDown={() => (resizing.current = true)} />
        <div style={{ width: panelWidth, flex: '0 0 auto', minWidth: 0 }}>
          <SidePanel
            selection={selection}
            loading={panelLoading}
            error={panelError}
            onOpenSymbol={openSymbol}
            onOpenFile={(path) => {
              goTo(path)
              void openFile(path)
            }}
          />
        </div>
      </div>
    </div>
  )
}
