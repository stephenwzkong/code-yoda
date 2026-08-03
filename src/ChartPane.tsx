import mermaid from 'mermaid'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { View, ViewNode } from '../server/graph.ts'
import { buildDiagram, nodeKeyFrom } from './mermaid-source.ts'

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  // 'loose' so our own <br/> in labels renders; label text is escaped in mermaid-source.
  securityLevel: 'loose',
  flowchart: { curve: 'basis', nodeSpacing: 40, rankSpacing: 70, htmlLabels: true },
})

interface Props {
  view: View
  selectedId?: string
  onSelect: (node: ViewNode) => void
}

export function ChartPane({ view, selectedId, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 })
  const [error, setError] = useState<string | null>(null)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const renderSeq = useRef(0)

  useEffect(() => {
    const seq = ++renderSeq.current
    const { source, nodeById } = buildDiagram(view)
    let cancelled = false

    mermaid
      .render(`yoda-${seq}`, source)
      .then(({ svg }) => {
        if (cancelled || !hostRef.current || seq !== renderSeq.current) return
        setError(null)
        hostRef.current.innerHTML = svg
        const svgEl = hostRef.current.querySelector('svg')
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
        for (const el of hostRef.current.querySelectorAll('g.node')) {
          const key = nodeKeyFrom(el.id || '')
          const node = key ? nodeById.get(key) : undefined
          if (!node) continue
          el.classList.add('yoda-node')
          if (node.id === selectedId) el.classList.add('yoda-selected')
          el.addEventListener('click', (event) => {
            event.stopPropagation()
            onSelect(node)
          })
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })

    return () => {
      cancelled = true
    }
  }, [view, selectedId, onSelect])

  // Reset the viewport whenever we move to a different scope.
  useEffect(() => setTransform({ x: 0, y: 0, scale: 1 }), [view.scope])

  const onWheel = useCallback((event: React.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 1) return
    event.preventDefault()
    setTransform((t) => {
      const next = Math.min(4, Math.max(0.15, t.scale * (event.deltaY < 0 ? 1.12 : 0.89)))
      return { ...t, scale: next }
    })
  }, [])

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return
    dragRef.current = { x: event.clientX, y: event.clientY, ox: transform.x, oy: transform.y }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return
    setTransform((t) => ({
      ...t,
      x: drag.ox + (event.clientX - drag.x),
      y: drag.oy + (event.clientY - drag.y),
    }))
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
        {error ? (
          <div className="chart-error">
            <strong>Could not render this diagram.</strong>
            <pre>{error}</pre>
          </div>
        ) : null}
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
