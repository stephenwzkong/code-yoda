import Anthropic from '@anthropic-ai/sdk'
import type { IR } from './types.ts'

/**
 * The AI view asks Claude to group a repo's files into named subsystems.
 *
 * Claude is deliberately NOT asked to emit Mermaid. It groups and names real
 * files; the diagram is then generated from those groupings plus the edges the
 * analyzers already resolved. That keeps every node clickable (each maps to a
 * real path), keeps edges compiler-verified rather than model-authored, and
 * confines the model to the one job it is actually better at than static
 * analysis — saying what a cluster of files is *for*.
 */
export interface RepoGroup {
  name: string
  purpose: string
  /** repo-relative paths, validated against the IR before being returned */
  paths: string[]
}

export interface OverviewResult {
  groups: RepoGroup[]
  model: string
  /** paths the model omitted, collected into a catch-all group */
  ungrouped: number
}

const MODEL = 'claude-opus-5'

/**
 * Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
 * `ant auth login` profile — the SDK checks all three. We only report whether
 * *something* is configured so the UI can disable the AI toggle with a reason
 * instead of failing on click.
 */
export function credentialsAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
}

const SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short subsystem name, 1-4 words' },
          purpose: { type: 'string', description: 'One sentence on what it does' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Repo-relative file paths, copied exactly from the input',
          },
        },
        required: ['name', 'purpose', 'paths'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups'],
  additionalProperties: false,
} as const

/**
 * A compact description of the repo: paths, a few symbol names each, and the
 * strongest file-to-file relationships. Sending the IR rather than source keeps
 * this to a few thousand tokens even for a large repo.
 */
function describeRepo(ir: IR): string {
  const files = ir.files.map((f) => {
    const names = f.symbols.slice(0, 8).map((s) => s.name)
    const more = f.symbols.length > names.length ? `, +${f.symbols.length - names.length} more` : ''
    return names.length ? `${f.path} — ${names.join(', ')}${more}` : f.path
  })

  const between = new Map<string, number>()
  for (const edge of ir.edges) {
    const from = edge.from.split('#')[0]
    const to = edge.to.split('#')[0]
    if (from === to) continue
    const key = `${from} -> ${to}`
    between.set(key, (between.get(key) ?? 0) + 1)
  }
  const links = [...between.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([pair, n]) => `${pair} (${n})`)

  return [
    `Files (${ir.files.length}), each with some of the symbols it defines:`,
    files.join('\n'),
    '',
    `Strongest file-to-file dependencies (import/call counts):`,
    links.join('\n'),
  ].join('\n')
}

const SYSTEM = `You are given a static analysis of a code repository: its files, the symbols each defines, and the dependencies between them.

Group the files into the subsystems a new engineer would need to understand — the parts this codebase is actually made of. Judge by what the code does, not by directory layout; a subsystem may span folders, and one folder may split across subsystems.

Rules:
- Every path you output must be copied exactly from the input. Never invent, rename, or shorten a path.
- Assign each file to exactly one group.
- Aim for 4-10 groups. Prefer a few meaningful groups over many tiny ones.
- Name groups for what they do ("Session memory", "Calendar tools"), not for where they live ("src/assistant/memory").
- Put tests, config, and scaffolding in their own group rather than scattering them.`

/** Ask Claude to group the repo, then validate every path against the IR. */
export async function buildOverview(ir: IR): Promise<OverviewResult> {
  const client = new Anthropic()

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    // Claude Opus 5 can decline a request; this re-runs it on a fallback model
    // server-side rather than surfacing a refusal for a benign repo.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: describeRepo(ir) }],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming)

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to analyze this repository.')
  }

  const text = response.content.find((block) => block.type === 'text')
  if (!text || text.type !== 'text') throw new Error('The model returned no grouping.')

  const parsed = JSON.parse(text.text) as { groups: RepoGroup[] }
  return validate(parsed.groups, ir, response.model)
}

/**
 * Keep only paths that exist, drop duplicates, and sweep anything the model
 * missed into a final group — so the diagram always accounts for every file.
 */
function validate(groups: RepoGroup[], ir: IR, model: string): OverviewResult {
  const real = new Set(ir.files.map((f) => f.path))
  const claimed = new Set<string>()

  const cleaned: RepoGroup[] = []
  for (const group of groups ?? []) {
    const paths = (group.paths ?? []).filter((p) => real.has(p) && !claimed.has(p))
    for (const p of paths) claimed.add(p)
    if (paths.length > 0) {
      cleaned.push({ name: String(group.name), purpose: String(group.purpose ?? ''), paths })
    }
  }

  const missed = [...real].filter((p) => !claimed.has(p))
  if (missed.length > 0) {
    cleaned.push({ name: 'Everything else', purpose: 'Files not assigned to a subsystem.', paths: missed })
  }

  return { groups: cleaned, model, ungrouped: missed.length }
}
