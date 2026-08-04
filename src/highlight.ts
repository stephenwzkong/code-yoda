import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import jsx from 'shiki/langs/jsx.mjs'
import python from 'shiki/langs/python.mjs'
import tsx from 'shiki/langs/tsx.mjs'
import githubDark from 'shiki/themes/github-dark.mjs'
import type { Lang } from '../server/types.ts'

const SHIKI_LANG: Record<Lang, string> = { ts: 'tsx', js: 'jsx', py: 'python' }

let highlighterPromise: Promise<HighlighterCore> | null = null

/** Only the three grammars we support — the full bundle is ~5MB of unused languages. */
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [githubDark],
    langs: [tsx, jsx, python],
    engine: import('shiki/engine/oniguruma').then(({ createOnigurumaEngine }) =>
      createOnigurumaEngine(import('shiki/wasm')),
    ),
  })
  return highlighterPromise
}

/**
 * Load the WASM regex engine and grammars ahead of time. That first load costs
 * ~700ms, and without this it lands on the first file the user opens, blocking
 * the diagram from swapping in.
 */
export function warmUpHighlighter(): void {
  const start = () => {
    void getHighlighter()
      // Touch both grammars so the first real call is pure tokenizing.
      .then((h) => {
        h.codeToHtml('x = 1', { lang: 'python', theme: 'github-dark' })
        h.codeToHtml('const x = 1', { lang: 'tsx', theme: 'github-dark' })
      })
      .catch(() => undefined)
  }
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => start(), { timeout: 1500 })
  else setTimeout(start, 300)
}

/**
 * Renders code to HTML, tagging every line with `data-line` so the panel can
 * scroll to a symbol, and marking the symbol's own range for highlighting.
 */
export async function highlight(
  code: string,
  lang: Lang,
  range?: { start: number; end: number },
): Promise<string> {
  const highlighter = await getHighlighter()
  return highlighter.codeToHtml(code, {
    lang: SHIKI_LANG[lang] ?? 'tsx',
    theme: 'github-dark',
    transformers: [
      {
        line(node, line) {
          node.properties['data-line'] = String(line)
          if (range && line >= range.start && line <= range.end) {
            this.addClassToHast(node, 'line-in-range')
          }
          if (range && line === range.start) this.addClassToHast(node, 'line-anchor')
        },
      },
    ],
  })
}
