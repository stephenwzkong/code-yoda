import fs from 'node:fs'
import path from 'node:path'
import { LANG_BY_EXT, type Lang } from './types.ts'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'site-packages',
  'vendor',
])

/** Files that are technically source but never worth graphing. */
function isGenerated(name: string): boolean {
  return /\.min\.[cm]?jsx?$/.test(name) || /\.d\.ts$/.test(name) || /\.bundle\.[cm]?jsx?$/.test(name)
}

export interface WalkedFile {
  /** repo-relative, posix separators */
  path: string
  abs: string
  lang: Lang
  size: number
  mtimeMs: number
}

export interface WalkResult {
  files: WalkedFile[]
  /** true when the cap was hit and `files` is a truncated view of the repo */
  truncated: boolean
  /** total source files seen before the cap, for the warning message */
  totalSeen: number
  /** repo-relative dir -> source file count, for "this repo is huge" guidance */
  dirCounts: Record<string, number>
}

export function walkRepo(root: string, cap = 3000): WalkResult {
  const files: WalkedFile[] = []
  const dirCounts: Record<string, number> = {}
  let totalSeen = 0

  const visit = (dir: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable dir (permissions, broken symlink) — skip rather than fail the whole walk
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        visit(abs)
        continue
      }
      if (!entry.isFile()) continue
      const lang = LANG_BY_EXT[path.extname(entry.name).toLowerCase()]
      if (!lang || isGenerated(entry.name)) continue

      totalSeen++
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '.'
      dirCounts[top] = (dirCounts[top] ?? 0) + 1
      if (files.length >= cap) continue

      const stat = fs.statSync(abs)
      files.push({ path: rel, abs, lang, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }

  visit(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, truncated: totalSeen > cap, totalSeen, dirCounts }
}
