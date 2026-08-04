import { useEffect, useMemo, useRef, useState } from 'react'
import type { FileDetail, SymbolDetail, SymbolRef } from './api.ts'
import { afterPaint } from './after-paint.ts'
import { highlight } from './highlight.ts'

export type Selection =
  | { kind: 'file'; detail: FileDetail }
  | { kind: 'symbol'; detail: SymbolDetail }

interface Props {
  selection: Selection | null
  loading: boolean
  error: string | null
  onOpenSymbol: (symbolId: string) => void
  onOpenFile: (path: string) => void
}

export function SidePanel({ selection, loading, error, onOpenSymbol, onOpenFile }: Props) {
  const [html, setHtml] = useState('')
  const codeRef = useRef<HTMLDivElement>(null)

  const view = useMemo(() => {
    if (!selection) return null
    if (selection.kind === 'symbol') {
      const { symbol, path, abs, lang, code, callers, callees } = selection.detail
      return {
        title: symbol.name,
        subtitle: `${path}:${symbol.line}`,
        kind: symbol.kind,
        doc: symbol.doc,
        abs,
        line: symbol.line,
        lang,
        code,
        range: { start: symbol.line, end: symbol.endLine },
        callers,
        callees,
      }
    }
    const { path, abs, lang, code, symbols } = selection.detail
    return {
      title: path.split('/').pop() ?? path,
      subtitle: path,
      kind: 'file' as const,
      doc: undefined,
      abs,
      line: 1,
      lang,
      code,
      range: undefined,
      symbols,
      callers: [] as SymbolRef[],
      callees: [] as SymbolRef[],
    }
  }, [selection])

  useEffect(() => {
    if (!view) {
      setHtml('')
      return
    }
    let cancelled = false
    // Syntax highlighting is synchronous CPU work. Wait for a paint first so it
    // can never delay the diagram swapping in.
    const cancel = afterPaint(() => {
      highlight(view.code, view.lang, view.range).then((out) => {
        if (!cancelled) setHtml(out)
      })
    })
    return () => {
      cancelled = true
      cancel()
    }
  }, [view])

  // Scroll the clicked symbol into view once its highlighted HTML is in the DOM.
  useEffect(() => {
    if (!html || !codeRef.current) return
    const anchor = codeRef.current.querySelector('.line-anchor')
    anchor?.scrollIntoView({ block: 'center' })
  }, [html])

  if (loading) return <aside className="side-panel"><div className="panel-empty">Loading…</div></aside>
  if (error) return <aside className="side-panel"><div className="panel-error">{error}</div></aside>
  if (!view) {
    return (
      <aside className="side-panel">
        <div className="panel-empty">
          <p>Click a block in the diagram to open it here.</p>
          <p className="muted">
            Folders and files drill the diagram down a level. Functions and classes open here without
            moving the diagram.
          </p>
        </div>
      </aside>
    )
  }

  return (
    <aside className="side-panel">
      <header className="panel-header">
        <div className="panel-title-row">
          <span className={`badge badge-${view.kind}`}>{view.kind}</span>
          <h2>{view.title}</h2>
        </div>
        <button className="link-button" onClick={() => onOpenFile(view.subtitle.split(':')[0])}>
          {view.subtitle}
        </button>
        <a className="vscode-link" href={`vscode://file/${view.abs}:${view.line}`}>
          Open in VS Code
        </a>
        {view.doc ? <p className="panel-doc">{view.doc}</p> : null}
      </header>

      {'symbols' in view && view.symbols?.length ? (
        <RefList
          title={`Symbols (${view.symbols.length})`}
          items={view.symbols.map((s) => ({ id: s.id, name: s.name, path: '', line: s.line, confidence: 'resolved' as const }))}
          onOpen={onOpenSymbol}
          showPath={false}
        />
      ) : null}
      <RefList title={`Callers (${view.callers.length})`} items={view.callers} onOpen={onOpenSymbol} />
      <RefList title={`Callees (${view.callees.length})`} items={view.callees} onOpen={onOpenSymbol} />

      {view.code.trim() === '' ? (
        <div className="panel-empty">This file is empty.</div>
      ) : (
        <div className="panel-code" ref={codeRef} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </aside>
  )
}

function RefList({
  title,
  items,
  onOpen,
  showPath = true,
}: {
  title: string
  items: SymbolRef[]
  onOpen: (id: string) => void
  showPath?: boolean
}) {
  const [open, setOpen] = useState(true)
  if (items.length === 0) return <div className="ref-list empty">{title}</div>
  return (
    <div className="ref-list">
      <button className="ref-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} {title}
      </button>
      {open ? (
        <ul>
          {items.map((item) => (
            <li key={`${item.id}-${item.line}`}>
              <button onClick={() => onOpen(item.id)} title={item.path}>
                <span className="ref-name">{item.name}</span>
                {showPath ? <span className="ref-path">{item.path}</span> : null}
                {item.confidence === 'heuristic' ? <span className="ref-guess" title="Name-matched, not resolved">guess</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
