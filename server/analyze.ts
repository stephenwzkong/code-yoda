import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { analyzePython } from './analyzers/python.ts'
import { analyzeTypeScript, dedupe } from './analyzers/typescript.ts'
import { CACHE_DIR, type Source } from './ingest.ts'
import type { IR } from './types.ts'
import { walkRepo } from './walk.ts'

const GRAPHS_DIR = path.join(CACHE_DIR, 'graphs')

export interface AnalysisMeta {
  repoId: string
  label: string
  root: string
  origin: Source['origin']
  fileCount: number
  symbolCount: number
  edgeCount: number
  langs: Record<string, number>
  warnings: string[]
  /** milliseconds spent parsing; 0 when served from cache */
  elapsedMs: number
  cached: boolean
}

export interface Analysis {
  ir: IR
  meta: AnalysisMeta
}

const memory = new Map<string, Analysis>()

/** Content signature of the repo: any edit, add or delete busts the cache. */
function signature(files: Array<{ path: string; size: number; mtimeMs: number }>): string {
  const hash = crypto.createHash('sha1')
  for (const f of files) hash.update(`${f.path}:${f.size}:${Math.round(f.mtimeMs)}\n`)
  return hash.digest('hex').slice(0, 16)
}

export async function analyze(source: Source, cap = 3000): Promise<Analysis> {
  const started = Date.now()
  const walked = walkRepo(source.root, cap)
  const sig = signature(walked.files)
  const cacheKey = `${source.repoId}-${sig}`

  const hit = memory.get(cacheKey) ?? readDiskCache(cacheKey)
  if (hit) {
    memory.set(cacheKey, hit)
    return { ir: hit.ir, meta: { ...hit.meta, cached: true, elapsedMs: 0 } }
  }

  const warnings: string[] = []
  if (walked.truncated) {
    const biggest = Object.entries(walked.dirCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([dir, n]) => `${dir} (${n})`)
      .join(', ')
    warnings.push(
      `Repo has ${walked.totalSeen} source files; analyzed the first ${cap}. Largest folders: ${biggest}. Point code-yoda at a subfolder for a complete graph.`,
    )
  }

  const [tsFragment, pyResult] = await Promise.all([
    Promise.resolve().then(() => analyzeTypeScript(source.root, walked.files)),
    analyzePython(source.root, walked.files).catch((err: Error) => {
      warnings.push(err.message)
      return { files: [], edges: [], errors: [] }
    }),
  ])

  for (const e of pyResult.errors.slice(0, 5)) warnings.push(`Skipped ${e.path}: ${e.message}`)
  if (pyResult.errors.length > 5) warnings.push(`…and ${pyResult.errors.length - 5} more unparseable files.`)

  const ir: IR = {
    root: source.root,
    files: [...tsFragment.files, ...pyResult.files].sort((a, b) => a.path.localeCompare(b.path)),
    edges: dedupe([...tsFragment.edges, ...pyResult.edges]),
  }

  const langs: Record<string, number> = {}
  for (const f of ir.files) langs[f.lang] = (langs[f.lang] ?? 0) + 1

  const analysis: Analysis = {
    ir,
    meta: {
      repoId: source.repoId,
      label: source.label,
      root: source.root,
      origin: source.origin,
      fileCount: ir.files.length,
      symbolCount: ir.files.reduce((n, f) => n + f.symbols.length, 0),
      edgeCount: ir.edges.length,
      langs,
      warnings,
      elapsedMs: Date.now() - started,
      cached: false,
    },
  }

  memory.set(cacheKey, analysis)
  writeDiskCache(cacheKey, analysis)
  return analysis
}

/** Look up an already-analyzed repo without re-walking it. */
export function getAnalysis(repoId: string): Analysis | undefined {
  for (const [key, value] of memory) if (key.startsWith(`${repoId}-`)) return value

  // Fall back to disk so that a server restart (which `tsx watch` does on every
  // save) does not strand an open page with "that repo is not loaded any more".
  try {
    const newest = fs
      .readdirSync(GRAPHS_DIR)
      .filter((name) => name.startsWith(`${repoId}-`) && name.endsWith('.json'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(GRAPHS_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]
    if (!newest) return undefined
    const analysis = JSON.parse(fs.readFileSync(path.join(GRAPHS_DIR, newest.name), 'utf8')) as Analysis
    memory.set(newest.name.replace(/\.json$/, ''), analysis)
    return analysis
  } catch {
    return undefined
  }
}

function readDiskCache(key: string): Analysis | undefined {
  const file = path.join(GRAPHS_DIR, `${key}.json`)
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Analysis
  } catch {
    return undefined
  }
}

function writeDiskCache(key: string, analysis: Analysis): void {
  try {
    fs.mkdirSync(GRAPHS_DIR, { recursive: true })
    fs.writeFileSync(path.join(GRAPHS_DIR, `${key}.json`), JSON.stringify(analysis))
  } catch {
    // A cache write failure must never fail the request.
  }
}
