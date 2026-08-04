import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { analyze, getAnalysis, type Analysis } from './analyze.ts'
import { DEFAULT_MAX_NODES, project } from './graph.ts'
import { IngestError, resolveSource } from './ingest.ts'
import { buildOverview, credentialsAvailable, credentialStatus, type RepoGroup } from './llm.ts'
import { projectOverview } from './overview-graph.ts'
import { fileOf, type IR } from './types.ts'

const app = express()
app.use(express.json())

const PORT = Number(process.env.PORT ?? 5173)

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** Load a previously analyzed repo, or 404 with a message the UI can show. */
function requireAnalysis(repoId: unknown): Analysis {
  if (typeof repoId !== 'string' || !repoId) throw new HttpError(400, 'repoId is required')
  const found = getAnalysis(repoId)
  if (!found) throw new HttpError(404, 'That repo is not loaded any more — analyze it again.')
  return found
}

/** Reject any path that escapes the analyzed repo. */
function safeAbs(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (!abs.startsWith(rootWithSep)) throw new HttpError(400, 'Path is outside the analyzed repo')
  return abs
}

function findSymbol(ir: IR, symbolId: string) {
  const file = ir.files.find((f) => f.path === fileOf(symbolId))
  const symbol = file?.symbols.find((s) => s.id === symbolId)
  return { file, symbol }
}

app.post('/api/analyze', async (req, res, next) => {
  try {
    const input = String(req.body?.source ?? '')
    const source = await resolveSource(input)
    const { meta } = await analyze(source)
    res.json(meta)
  } catch (err) {
    next(err instanceof IngestError ? new HttpError(400, err.message) : err)
  }
})

app.get('/api/view', (req, res, next) => {
  try {
    const { ir, meta } = requireAnalysis(req.query.repoId)
    const scope = String(req.query.scope ?? '')
    if (scope && !ir.files.some((f) => f.path === scope || f.path.startsWith(`${scope}/`))) {
      throw new HttpError(404, `Nothing to show under "${scope}"`)
    }
    res.json(
      project(ir, scope, {
        rootLabel: meta.label,
        expand: req.query.expand === '1',
        maxNodes: Number(req.query.maxNodes) || DEFAULT_MAX_NODES,
      }),
    )
  } catch (err) {
    next(err)
  }
})

/** Cached per repo: the grouping costs a model call, and it is stable input. */
const overviews = new Map<string, RepoGroup[]>()

app.get('/api/overview', async (req, res, next) => {
  try {
    const { ir } = requireAnalysis(req.query.repoId)
    const repoId = String(req.query.repoId)

    let groups = overviews.get(repoId)
    if (!groups) {
      if (!credentialsAvailable()) {
        throw new HttpError(
          503,
          'The AI view needs Anthropic credentials. Either export ANTHROPIC_API_KEY, or sign in to ' +
            'your Claude account with `ant auth login`. Restart the server afterwards.',
        )
      }
      const result = await buildOverview(ir)
      groups = result.groups
      overviews.set(repoId, groups)
    }

    res.json(projectOverview(ir, groups))
  } catch (err) {
    next(err instanceof HttpError ? err : new HttpError(502, (err as Error).message))
  }
})

/** Lets the UI disable the AI toggle with a reason rather than failing on click. */
app.get('/api/overview/available', (_req, res) => {
  res.json(credentialStatus())
})

app.get('/api/source', (req, res, next) => {
  try {
    const { ir } = requireAnalysis(req.query.repoId)
    const relPath = String(req.query.path ?? '')
    const file = ir.files.find((f) => f.path === relPath)
    if (!file) throw new HttpError(404, `Not an analyzed file: ${relPath}`)
    const abs = safeAbs(ir.root, relPath)
    res.json({
      path: relPath,
      abs,
      lang: file.lang,
      code: fs.readFileSync(abs, 'utf8'),
      symbols: file.symbols,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Folder contents for the side panel. Clicking a folder drills the diagram in;
 * this makes the panel respond too, so every click produces something visible.
 */
app.get('/api/folder', (req, res, next) => {
  try {
    const { ir } = requireAnalysis(req.query.repoId)
    const scope = String(req.query.path ?? '')
    const prefix = scope ? `${scope}/` : ''
    const files = ir.files.filter((f) => f.path.startsWith(prefix))
    if (files.length === 0) throw new HttpError(404, `No analyzed files under "${scope}"`)

    const langs: Record<string, number> = {}
    for (const f of files) langs[f.lang] = (langs[f.lang] ?? 0) + 1

    res.json({
      path: scope,
      fileCount: files.length,
      symbolCount: files.reduce((n, f) => n + f.symbols.length, 0),
      langs,
      files: files
        .map((f) => ({ path: f.path, name: f.path.slice(prefix.length), symbols: f.symbols.length }))
        .sort((a, b) => b.symbols - a.symbols || a.name.localeCompare(b.name))
        .slice(0, 200),
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Accepts an API key typed into the UI, so the AI view can be enabled without
 * restarting the server or editing a shell profile. Held in memory only — it is
 * never written to disk, and is gone when the server stops.
 */
app.post('/api/credentials', (req, res, next) => {
  try {
    const key = String(req.body?.apiKey ?? '').trim()
    if (!key) throw new HttpError(400, 'Paste an API key first.')
    if (!key.startsWith('sk-ant-')) {
      throw new HttpError(400, 'That does not look like an Anthropic API key (they start with sk-ant-).')
    }
    process.env.ANTHROPIC_API_KEY = key
    res.json(credentialStatus())
  } catch (err) {
    next(err)
  }
})

app.get('/api/symbol', (req, res, next) => {
  try {
    const { ir } = requireAnalysis(req.query.repoId)
    const symbolId = String(req.query.id ?? '')
    const { file, symbol } = findSymbol(ir, symbolId)
    if (!file || !symbol) throw new HttpError(404, `Unknown symbol: ${symbolId}`)
    const abs = safeAbs(ir.root, file.path)

    const label = (id: string) => {
      const found = findSymbol(ir, id)
      return {
        id,
        name: found.symbol?.name ?? '(module scope)',
        path: fileOf(id),
        line: found.symbol?.line ?? 1,
      }
    }

    res.json({
      symbol,
      path: file.path,
      abs,
      lang: file.lang,
      code: fs.readFileSync(abs, 'utf8'),
      callers: ir.edges.filter((e) => e.kind === 'call' && e.to === symbolId).map((e) => ({ ...label(e.from), confidence: e.confidence })),
      callees: ir.edges.filter((e) => e.kind === 'call' && e.from === symbolId).map((e) => ({ ...label(e.to), confidence: e.confidence })),
    })
  } catch (err) {
    next(err)
  }
})

app.get('/api/search', (req, res, next) => {
  try {
    const { ir } = requireAnalysis(req.query.repoId)
    const q = String(req.query.q ?? '').toLowerCase().trim()
    if (!q) {
      res.json([])
      return
    }
    const hits: Array<{ id: string; name: string; path: string; kind: string; line: number }> = []
    for (const file of ir.files) {
      if (file.path.toLowerCase().includes(q)) {
        hits.push({ id: file.path, name: file.path.split('/').pop()!, path: file.path, kind: 'file', line: 1 })
      }
      for (const sym of file.symbols) {
        if (sym.name.toLowerCase().includes(q)) {
          hits.push({ id: sym.id, name: sym.name, path: file.path, kind: sym.kind, line: sym.line })
        }
      }
      if (hits.length > 100) break
    }
    res.json(hits.slice(0, 50))
  } catch (err) {
    next(err)
  }
})

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500
  const message = err instanceof Error ? err.message : 'Unexpected error'
  if (status === 500) console.error(err)
  res.status(status).json({ error: message })
})

async function start() {
  if (process.env.NODE_ENV === 'production') {
    const clientDir = path.resolve(process.cwd(), 'dist/client')
    app.use(express.static(clientDir))
    app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')))
  } else {
    const { createServer } = await import('vite')
    const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' })
    app.use(vite.middlewares)
  }
  // Bind to loopback only. This server will analyze any path it is given and
  // serve those files back, so it must never be reachable from the network.
  const HOST = process.env.HOST ?? '127.0.0.1'
  app.listen(PORT, HOST, () => console.log(`code-yoda running at http://localhost:${PORT}`))
}

start()
