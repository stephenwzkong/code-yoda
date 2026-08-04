/**
 * Run `fn` once the browser has had a chance to paint.
 *
 * Used to keep expensive follow-up work (fetching a file, syntax highlighting)
 * from stealing the main thread before the diagram is on screen.
 *
 * `requestAnimationFrame` alone is not enough: it never fires while a tab is
 * in the background, which would leave the deferred work permanently unrun. A
 * timer runs alongside it as a fallback, and whichever fires first wins.
 */
export function afterPaint(fn: () => void, fallbackMs = 100): () => void {
  let done = false
  const run = () => {
    if (done) return
    done = true
    fn()
  }
  const frame = requestAnimationFrame(() => setTimeout(run, 0))
  const timer = setTimeout(run, fallbackMs)
  return () => {
    done = true
    cancelAnimationFrame(frame)
    clearTimeout(timer)
  }
}
