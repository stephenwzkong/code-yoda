import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IRFragment } from '../types.ts'
import type { WalkedFile } from '../walk.ts'

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'analyze.py')

export interface PythonResult extends IRFragment {
  /** files that could not be parsed — surfaced to the UI rather than swallowed */
  errors: Array<{ path: string; message: string }>
}

/** Runs the stdlib-`ast` helper over the repo's Python files. */
export function analyzePython(root: string, walked: WalkedFile[]): Promise<PythonResult> {
  const files = walked.filter((f) => f.lang === 'py').map((f) => f.path)
  if (files.length === 0) return Promise.resolve({ files: [], edges: [], errors: [] })

  return new Promise((resolve, reject) => {
    const child = execFile(
      process.env.PYTHON ?? 'python3',
      [SCRIPT],
      { maxBuffer: 256 * 1024 * 1024, timeout: 300_000 },
      (err, stdout, stderr) => {
        if (err) {
          const hint =
            (err as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'python3 was not found on PATH. Install it, or set PYTHON to an interpreter path.'
              : stderr.trim() || err.message
          reject(new Error(`Python analysis failed: ${hint}`))
          return
        }
        try {
          resolve(JSON.parse(stdout) as PythonResult)
        } catch {
          reject(new Error(`Python analyzer returned invalid JSON: ${stdout.slice(0, 200)}`))
        }
      },
    )
    child.stdin?.end(JSON.stringify({ root, files }))
  })
}
