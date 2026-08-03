import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const CACHE_DIR = path.resolve(process.cwd(), '.cache')
const REPOS_DIR = path.join(CACHE_DIR, 'repos')

export interface Source {
  /** absolute path to the directory to analyze */
  root: string
  /** human-readable label for the UI */
  label: string
  /** stable id used for cache filenames */
  repoId: string
  origin: 'local' | 'github'
}

export class IngestError extends Error {}

const GITHUB_RE = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+))?\/?$/

export function looksLikeUrl(input: string): boolean {
  return GITHUB_RE.test(input.trim())
}

function idFor(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12)
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

/** Resolve a user-supplied path or GitHub URL into a local directory to analyze. */
export async function resolveSource(input: string): Promise<Source> {
  const trimmed = input.trim()
  if (!trimmed) throw new IngestError('Enter a local folder path or a GitHub URL.')

  const match = GITHUB_RE.exec(trimmed)
  if (match) return cloneGithub(trimmed, match)

  const root = path.resolve(expandHome(trimmed))
  let stat: fs.Stats
  try {
    stat = fs.statSync(root)
  } catch {
    throw new IngestError(`No such folder: ${root}`)
  }
  if (!stat.isDirectory()) throw new IngestError(`Not a folder: ${root}`)

  return { root, label: path.basename(root), repoId: idFor(root), origin: 'local' }
}

async function cloneGithub(url: string, match: RegExpExecArray): Promise<Source> {
  const [, owner, repo, ref] = match
  const cloneUrl = `https://github.com/${owner}/${repo}.git`
  const repoId = idFor(ref ? `${cloneUrl}#${ref}` : cloneUrl)
  const dest = path.join(REPOS_DIR, repoId)

  if (fs.existsSync(path.join(dest, '.git'))) {
    return { root: dest, label: `${owner}/${repo}`, repoId, origin: 'github' }
  }

  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(REPOS_DIR, { recursive: true })
  const args = ['clone', '--depth', '1', '--single-branch']
  if (ref) args.push('--branch', ref)
  args.push(cloneUrl, dest)

  try {
    // GIT_TERMINAL_PROMPT=0 so a private repo without credentials fails fast
    // instead of hanging the request on a username prompt.
    await run('git', args, { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 180_000 })
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true })
    const stderr = (err as { stderr?: string }).stderr ?? ''
    if (/Authentication failed|could not read Username|Permission denied/i.test(stderr)) {
      throw new IngestError(
        `Could not access ${owner}/${repo} — it may be private. Set up git credentials (e.g. \`gh auth login\`) and try again.`,
      )
    }
    if (/not found|Repository not found/i.test(stderr)) {
      throw new IngestError(`Repository not found: ${owner}/${repo}`)
    }
    throw new IngestError(`git clone failed: ${stderr.trim().split('\n').pop() ?? String(err)}`)
  }

  return { root: dest, label: `${owner}/${repo}`, repoId, origin: 'github' }
}
