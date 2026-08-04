import mermaid from 'mermaid'
import type { View, ViewNode } from '../server/graph.ts'
import { fetchOverview, fetchView } from './api.ts'
import { buildDiagram } from './mermaid-source.ts'

mermaid.initialize({
  startOnLoad: false,
  // 'loose' so our own <br/> in labels renders; label text is escaped in mermaid-source.
  securityLevel: 'loose',
  theme: 'dark',
  flowchart: { curve: 'basis', nodeSpacing: 40, rankSpacing: 70, htmlLabels: true },
})

export interface Diagram {
  view: View
  svg: string
  nodeById: Map<string, ViewNode>
  /** subgraph alias -> subsystem name, for the poster's clickable boxes */
  groupByKey: Map<string, string>
}

/** Lower runs first. A click must never wait behind speculative work. */
export const PRIORITY_USER = 0
export const PRIORITY_PREFETCH = 1

/**
 * Mermaid layout costs 30-260ms depending on the view and cannot run
 * concurrently with itself, so renders go through one prioritized queue.
 * Rendering is done once per scope and kept, so revisiting a level is instant.
 */
const cache = new Map<string, Diagram>()

interface RenderTask {
  source: string
  priority: number
  group: string
  cancelled: boolean
  resolve: (svg: string) => void
  reject: (err: unknown) => void
}

const queue: RenderTask[] = []
const pendingTasks = new Map<string, RenderTask>()
const inflight = new Map<string, Promise<Diagram>>()
let pumping = false
let renderSeq = 0

/** Which projection produced a diagram: the analyzers, or Claude's grouping. */
export type DiagramMode = 'analyzed' | 'ai'

function keyOf(repoId: string, scope: string, expand: boolean, mode: DiagramMode = 'analyzed'): string {
  return `${repoId} ${scope} ${expand ? 'x' : ''} ${mode}`
}

function enqueueRender(source: string, priority: number, group: string): [Promise<string>, RenderTask] {
  let task!: RenderTask
  const promise = new Promise<string>((resolve, reject) => {
    task = { source, priority, group, cancelled: false, resolve, reject }
    queue.push(task)
  })
  void pump()
  return [promise, task]
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (queue.length > 0) {
      // Re-sort every pass: a click can arrive while an earlier render runs.
      queue.sort((a, b) => a.priority - b.priority)
      const task = queue.shift()!
      if (task.cancelled) {
        task.reject(new Error('cancelled'))
        continue
      }
      try {
        const { svg } = await mermaid.render(`yoda-${renderSeq++}`, task.source)
        task.resolve(svg)
      } catch (err) {
        task.reject(err)
      }
      // Yield so the browser can handle input and paint between renders;
      // without this a queue of prefetches freezes the UI.
      await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    pumping = false
  }
}

export function peek(
  repoId: string,
  scope: string,
  expand: boolean,
  mode: DiagramMode = 'analyzed',
): Diagram | undefined {
  return cache.get(keyOf(repoId, scope, expand, mode))
}

/** Fetch + build + render a scope, reusing any cached or in-flight result. */
export function loadDiagram(
  repoId: string,
  scope: string,
  expand = false,
  priority = PRIORITY_USER,
  group = 'user',
  mode: DiagramMode = 'analyzed',
): Promise<Diagram> {
  const key = keyOf(repoId, scope, expand, mode)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)

  const pending = inflight.get(key)
  if (pending) {
    // Already queued as speculative work and now actually wanted: promote it
    // rather than waiting for the prefetch backlog to drain.
    const task = pendingTasks.get(key)
    if (task && priority < task.priority) {
      task.priority = priority
      task.cancelled = false
    }
    return pending
  }

  const view = mode === 'ai' ? fetchOverview(repoId, scope) : fetchView(repoId, scope, expand)
  return startLoad(key, view, priority, group)
}

/** Shared tail of loadDiagram: render a (possibly already fetched) view and cache it. */
function startLoad(
  key: string,
  viewPromise: Promise<View>,
  priority: number,
  group: string,
): Promise<Diagram> {
  const promise = viewPromise
    .then(async (view) => {
      const { source, nodeById, groupByKey } = buildDiagram(view)
      const [rendered, task] = enqueueRender(source, priority, group)
      pendingTasks.set(key, task)
      const diagram: Diagram = { view, svg: await rendered, nodeById, groupByKey }
      cache.set(key, diagram)
      return diagram
    })
    .finally(() => {
      inflight.delete(key)
      pendingTasks.delete(key)
    })

  inflight.set(key, promise)
  return promise
}

const idle: (cb: () => void) => void =
  typeof requestIdleCallback === 'function'
    ? (cb) => requestIdleCallback(() => cb(), { timeout: 400 })
    : (cb) => setTimeout(cb, 50)

let prefetchGeneration = 0

/**
 * Render the levels the user is most likely to open next, during idle time, at
 * a priority that always yields to a real click.
 */
export function prefetchChildren(repoId: string, view: View, limit = 3): () => void {
  const group = `prefetch:${++prefetchGeneration}`
  let cancelled = false

  // Most-connected first: a hub file is far likelier to be opened than a leaf,
  // and alphabetical order would spend the budget on whatever starts with "a".
  const degree = new Map<string, number>()
  for (const edge of view.edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + edge.count)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + edge.count)
  }

  const targets = view.nodes
    .filter((n) => n.kind === 'folder' || n.kind === 'file')
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .map((n) => n.path)
    .filter((scope) => !cache.has(keyOf(repoId, scope, false)))
    .slice(0, limit)

  const step = (i: number) => {
    if (cancelled || i >= targets.length) return
    idle(() => {
      if (cancelled) return
      prefetchOne(repoId, targets[i], group)
        .catch(() => undefined)
        .then(() => step(i + 1))
    })
  }
  step(0)

  // Deliberately does NOT cancel work already queued. Rejecting a render that a
  // click has since started awaiting would strand that click with no diagram.
  return () => {
    cancelled = true
  }
}

/** Node count past which laying a view out speculatively costs more than it saves. */
const PREFETCH_MAX_NODES = 40

/**
 * Prefetch one scope, but only render it if it is small. Fetching is ~3ms and
 * always worth it; laying out a 60-node folder is a quarter-second of blocked
 * main thread, and doing several of those makes the page feel frozen.
 */
async function prefetchOne(repoId: string, scope: string, group: string): Promise<void> {
  const key = keyOf(repoId, scope, false)
  if (cache.has(key) || inflight.has(key)) return
  const view = await fetchView(repoId, scope, false)
  if (view.nodes.length > PREFETCH_MAX_NODES) return
  await startLoad(key, Promise.resolve(view), PRIORITY_PREFETCH, group)
}

export function invalidateRepo(repoId: string): void {
  for (const key of [...cache.keys()]) if (key.startsWith(`${repoId} `)) cache.delete(key)
}

/**
 * Pay Mermaid's one-time warm-up while the user is still reading the empty
 * state, rather than on their first real diagram.
 */
export function warmUp(): void {
  idle(() => {
    const [promise] = enqueueRender('flowchart LR\n  warm["."]', PRIORITY_PREFETCH, 'warmup')
    void promise.catch(() => undefined)
  })
}
