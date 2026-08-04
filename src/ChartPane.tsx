import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewNode } from '../server/graph.ts'
import type { Diagram } from './diagram-cache.ts'
import { nodeKeyFrom } from './mermaid-source.ts'

interface Props {
  diagram: Diagram
  selectedId?: string
  onSelect: (node: ViewNode) => void
  /** Called when the pointer enters a node, so the next level can be prepared. */
  onHover?: (node: ViewNode) => void
  /** True while a level that was not already laid out is being prepared. */
  pending?: boolean
  pendingLabel?: string
}

/**
 * How long the pointer must rest on a node before we speculatively lay out its
 * level. Long enough that crossing a node costs nothing, short enough to still
 * beat the click that usually follows.
 */
const HOVER_DWELL_MS = 120

/** Explains what the diagram's shapes and edge numbers mean. Collapsible. */
function Legend({ scopeKind }: { scopeKind: 'dir' | 'file' }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={open ? 'chart-legend open' : 'chart-legend'}>
      <button onClick={() => setOpen((o) => !o)}>{open ? '▾' : '▸'} Legend</button>
      {open ? (
        <dl>
          <dt className="lg-edge-count">3</dt>
          <dd>
            {scopeKind === 'dir'
              ? 'How many imports and calls cross between these two blocks. Thicker relationships mean more coupling.'
              : 'How many times this function calls the other.'}
          </dd>
          <dt className="lg-dashed">– – ▸</dt>
          <dd>
            A dashed edge is a <em>guess</em>: matched by name because the target could not be
            resolved. A solid edge was resolved for certain.
          </dd>
          {scopeKind === 'dir' ? (
            <>
              <dt className="lg-folder">▭</dt>
              <dd>Folder — click to open it. The small number is how many files it holds.</dd>
              <dt className="lg-file">▭</dt>
              <dd>File — the small number is how many symbols it defines.</dd>
            </>
          ) : (
            <>
              <dt className="lg-fn">▭</dt>
              <dd>Function or method</dd>
              <dt className="lg-class">⬡</dt>
              <dd>Class</dd>
              <dt className="lg-var">▭</dt>
              <dd>Module-level object, e.g. <code>agent = LlmAgent(…)</code></dd>
              <dt className="lg-ext">▱</dt>
              <dd>Something in another file, shown for context</dd>
            </>
          )}
        </dl>
      ) : null}
    </div>
  )
}

/** A synthetic folder node for the parent scope, for the empty-state back link. */
function upOneLevel(scope: string): ViewNode {
  const parent = scope.includes('/') ? scope.slice(0, scope.lastIndexOf('/')) : ''
  return { id: parent, label: parent, kind: 'folder', path: parent }
}

export function ChartPane({ diagram, selectedId, onSelect, onHover, pending, pendingLabel }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  // Held in a ref so that a new click handler never re-triggers the mount effect:
  // re-running it would re-lay-out the whole diagram, which costs ~250ms.
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onHoverRef = useRef(onHover)
  onHoverRef.current = onHover

  // Mount the pre-rendered SVG. Runs only when the diagram itself changes.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.innerHTML = diagram.svg

    const svgEl = host.querySelector('svg')
    if (svgEl) {
      // Mermaid emits a percentage width, which collapses to zero inside a
      // max-content stage. Pin the SVG to its viewBox size instead.
      const [, , vbWidth, vbHeight] = (svgEl.getAttribute('viewBox') ?? '0 0 800 600')
        .split(/\s+/)
        .map(Number)
      svgEl.setAttribute('width', String(vbWidth))
      svgEl.setAttribute('height', String(vbHeight))
      svgEl.style.maxWidth = 'none'
    }

    for (const el of host.querySelectorAll('g.node')) {
      const node = diagram.nodeById.get(nodeKeyFrom(el.id || '') ?? '')
      if (!node) continue
      el.classList.add('yoda-node')
      el.addEventListener('click', (event) => {
        event.stopPropagation()
        // Acknowledge the click on the node itself, before any work starts —
        // otherwise a slow level looks like the click was missed.
        if (node.kind === 'folder' || node.kind === 'file' || node.kind === 'more') {
          el.classList.add('yoda-activating')
        }
        onSelectRef.current(node)
      })
      // Hovering precedes clicking, which is enough lead time to lay out the
      // next level. Only fire once the pointer *rests* on a node: sweeping
      // across a graph would otherwise queue a layout for every node crossed.
      let dwell: ReturnType<typeof setTimeout> | undefined
      el.addEventListener('mouseenter', () => {
        dwell = setTimeout(() => onHoverRef.current?.(node), HOVER_DWELL_MS)
      })
      el.addEventListener('mouseleave', () => clearTimeout(dwell))
    }
  }, [diagram])

  // Selection is a class toggle, never a re-render.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    for (const el of host.querySelectorAll('g.node')) {
      const node = diagram.nodeById.get(nodeKeyFrom(el.id || '') ?? '')
      el.classList.toggle('yoda-selected', !!node && node.id === selectedId)
    }
  }, [diagram, selectedId])

  // Reset the viewport when we move to a different scope.
  useEffect(() => setTransform({ x: 0, y: 0, scale: 1 }), [diagram.view.scope])

  const onWheel = useCallback((event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 1) return
    event.preventDefault()
    setTransform((t) => ({ ...t, scale: Math.min(4, Math.max(0.15, t.scale * (event.deltaY < 0 ? 1.12 : 0.89))) }))
  }, [])

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    dragRef.current = { x: event.clientX, y: event.clientY, ox: transform.x, oy: transform.y }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    setTransform((t) => ({ ...t, x: drag.ox + (event.clientX - drag.x), y: drag.oy + (event.clientY - drag.y) }))
  }

  const endDrag = () => {
    dragRef.current = null
  }

  const isEmpty = diagram.view.nodes.length === 0

  return (
    <div className={pending ? 'chart-pane is-pending' : 'chart-pane'}>
      {isEmpty && !pending ? (
        <div className="chart-empty">
          <h2>Nothing to diagram here</h2>
          {diagram.view.scopeKind === 'file' ? (
            <p>
              <code>{diagram.view.scope.split('/').pop()}</code> has no functions, classes or
              module-level objects — its source is in the panel on the right.
            </p>
          ) : (
            <p>
              <code>{diagram.view.scope || 'This repo'}</code> has no analyzable Python or
              JavaScript/TypeScript files.
            </p>
          )}
          <button className="link-button" onClick={() => onSelect(upOneLevel(diagram.view.scope))}>
            ← Back up a level
          </button>
        </div>
      ) : null}
      {pending ? (
        <div className="chart-overlay" role="status" aria-live="polite">
          <div className="chart-spinner" />
          <span>
            {pendingLabel ? <strong>{pendingLabel}</strong> : 'Laying out diagram'}…
          </span>
        </div>
      ) : null}
      <div
        className="chart-viewport"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          ref={hostRef}
          className="chart-stage"
          style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
        />
      </div>
      <Legend scopeKind={diagram.view.scopeKind} />
      <div className="chart-controls">
        <button onClick={() => setTransform((t) => ({ ...t, scale: Math.min(4, t.scale * 1.2) }))}>+</button>
        <button onClick={() => setTransform((t) => ({ ...t, scale: Math.max(0.15, t.scale / 1.2) }))}>−</button>
        <button onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>Reset</button>
        <span className="chart-hint">drag to pan · scroll to zoom</span>
      </div>
    </div>
  )
}
