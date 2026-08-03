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
}

export function ChartPane({ diagram, selectedId, onSelect, onHover }: Props) {
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
        onSelectRef.current(node)
      })
      // Hovering reliably precedes clicking, which is enough lead time to lay
      // out the next level before it is asked for.
      el.addEventListener('mouseenter', () => onHoverRef.current?.(node), { once: true })
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

  return (
    <div className="chart-pane">
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
      <div className="chart-controls">
        <button onClick={() => setTransform((t) => ({ ...t, scale: Math.min(4, t.scale * 1.2) }))}>+</button>
        <button onClick={() => setTransform((t) => ({ ...t, scale: Math.max(0.15, t.scale / 1.2) }))}>−</button>
        <button onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>Reset</button>
        <span className="chart-hint">drag to pan · scroll to zoom</span>
      </div>
    </div>
  )
}
