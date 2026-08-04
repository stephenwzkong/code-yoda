import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewNode } from '../server/graph.ts'
import {
  analyzeSource,
  fetchFile,
  fetchFolder,
  fetchSymbol,
  overviewAvailable,
  saveApiKey,
  search,
  type CredentialStatus,
  type Meta,
  type SearchHit,
} from './api.ts'
import { Breadcrumbs } from './Breadcrumbs.tsx'
import { ChartPane } from './ChartPane.tsx'
import {
  invalidateRepo,
  loadDiagram,
  peek,
  prefetchChildren,
  PRIORITY_PREFETCH,
  warmUp,
  type Diagram,
  type DiagramMode,
} from './diagram-cache.ts'
import { warmUpHighlighter } from './highlight.ts'
import { SidePanel, type Selection } from './SidePanel.tsx'

const LAST_SOURCE_KEY = 'code-yoda:last-source'

/** The folder a path lives in — diagrams are scoped to folders, never files. */
function parentDir(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

export function App() {
  const [sourceInput, setSourceInput] = useState(() => localStorage.getItem(LAST_SOURCE_KEY) ?? '')
  const [meta, setMeta] = useState<Meta | null>(null)
  const [scope, setScope] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [mode, setMode] = useState<DiagramMode>('analyzed')
  const [auth, setAuth] = useState<CredentialStatus | null>(null)
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
  const [keyInput, setKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)
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

  // Mermaid (~60ms) and Shiki (~700ms of WASM + grammars) both have a one-time
  // start-up cost. Pay both while the empty state is on screen rather than on
  // the user's first diagram and first opened file.
  useEffect(() => {
    warmUp()
    warmUpHighlighter()
    void overviewAvailable()
      .then(setAuth)
      .catch(() => setAuth({ available: false, method: 'none', detail: 'server unreachable' }))
  }, [])

  // Load the diagram whenever the repo or scope changes, then render the levels
  // below it in the background so the next click has nothing left to compute.
  useEffect(() => {
    if (!meta) return
    let cancelled = false
    let stopPrefetch: (() => void) | undefined

    // A cached level swaps in synchronously — no spinner, no flash of emptiness.
    const cached = peek(meta.repoId, scope, expanded, mode)
    if (cached) setDiagram(cached)
    else setChartPending(true)

    loadDiagram(meta.repoId, scope, expanded, undefined, undefined, mode)
      .then((next) => {
        if (cancelled) return
        setDiagram(next)
        setError(null)
        // Prefetch only walks the deterministic tree; AI levels are two deep
        // and each one is already resolved from the cached grouping.
        if (mode === 'analyzed') stopPrefetch = prefetchChildren(meta.repoId, next.view)
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
  }, [meta, scope, expanded, mode])

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

  const openFolder = useCallback(
    async (path: string) => {
      if (!meta) return
      setPanelLoading(true)
      setPanelError(null)
      setSelectedNodeId(path)
      try {
        setSelection({ kind: 'folder', detail: await fetchFolder(meta.repoId, path) })
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
          // Drill the chart in AND describe the folder, so a click always
          // changes both halves of the screen.
          goTo(node.path)
          void openFolder(node.path)
          return
        case 'file':
          // Diagrams stop at files, so this only opens the source — the chart
          // stays where it is and keeps the file's context around it visible.
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
    [goTo, openFile, openFolder, openSymbol],
  )

  const onNodeHover = useCallback(
    (node: ViewNode) => {
      if (!meta || mode !== 'analyzed') return
      if (node.kind !== 'folder' && node.kind !== 'file') return
      // Speculative: must never be queued at click priority, or a real click
      // waits behind the backlog left by sweeping the pointer across the graph.
      void loadDiagram(meta.repoId, node.path, false, PRIORITY_PREFETCH, 'hover').catch(
        () => undefined,
      )
    },
    [meta, mode],
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
    // Diagrams stop at files, so show the folder the hit lives in and open the
    // file or symbol itself in the panel.
    goTo(parentDir(hit.path))
    if (hit.kind === 'file') void openFile(hit.path)
    else void openSymbol(hit.id)
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
          <div className="mode-toggle" role="group" aria-label="Diagram source">
            <button
              className={mode === 'analyzed' ? 'active' : ''}
              onClick={() => {
                setMode('analyzed')
                goTo('')
              }}
              title="Folders and files, with edges resolved by the compiler and Python ast"
            >
              Analyzed
            </button>
            <button
              className={mode === 'ai' ? 'active' : ''}
              disabled={!auth?.available}
              onClick={() => {
                setMode('ai')
                goTo('')
              }}
              title={
                auth?.available
                  ? `Subsystems grouped and named by Claude, over the same resolved edges — using ${auth.detail}`
                  : 'Needs Anthropic credentials — see the note in the toolbar'
              }
            >
              AI subsystems
            </button>
          </div>
        ) : null}
        {meta ? (
          <div className="repo-stats">
            {meta.fileCount} files · {meta.symbolCount} symbols · {meta.edgeCount} edges
            {meta.cached ? ' · cached' : ` · ${(meta.elapsedMs / 1000).toFixed(1)}s`}
          </div>
        ) : null}
      </header>

      {mode === 'ai' && auth?.available ? (
        <div className="banner info">Subsystems named by Claude · authenticated via {auth.detail}</div>
      ) : null}
      {meta && auth && !auth.available ? (
        <div className="banner warn">
          <form
            className="key-form"
            onSubmit={(event) => {
              event.preventDefault()
              setSavingKey(true)
              saveApiKey(keyInput)
                .then((status) => {
                  setAuth(status)
                  setKeyInput('')
                  setError(null)
                })
                .catch((err: Error) => setError(err.message))
                .finally(() => setSavingKey(false))
            }}
          >
            <strong>AI subsystems is off.</strong>
            <span>Paste an Anthropic API key to turn it on:</span>
            <input
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder="sk-ant-…"
              autoComplete="off"
              spellCheck={false}
              aria-label="Anthropic API key"
            />
            <button type="submit" disabled={savingKey || !keyInput.trim()}>
              {savingKey ? 'Checking…' : 'Use key'}
            </button>
          </form>
          <p className="key-note">
            Kept in the server's memory only — never written to disk, and gone when it stops.
            Alternatively sign in with your Claude account: run <code>ant auth login</code> in a
            terminal, then restart the server.
          </p>
        </div>
      ) : null}
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
              <ChartPane
                diagram={diagram}
                selectedId={selectedNodeId}
                onSelect={onNodeSelect}
                onHover={onNodeHover}
                pending={chartPending}
                pendingLabel={mode === 'ai' ? 'Claude is grouping this repo' : scope.split('/').pop()}
              />
            </>
          ) : chartPending ? (
            <div className="empty-state">
              <div className="chart-spinner" />
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
              goTo(parentDir(path))
              void openFile(path)
            }}
          />
        </div>
      </div>
    </div>
  )
}
