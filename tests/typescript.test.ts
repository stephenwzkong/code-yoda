import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeTypeScript } from '../server/analyzers/typescript.ts'
import { walkRepo } from '../server/walk.ts'

const ROOT = path.resolve(process.cwd(), 'fixtures/ts')
const fragment = analyzeTypeScript(ROOT, walkRepo(ROOT).files)

const names = (file: string) =>
  fragment.files.find((f) => f.path === file)?.symbols.map((s) => s.name) ?? []

const hasEdge = (from: string, to: string, kind: 'call' | 'import') =>
  fragment.edges.some((e) => e.from === from && e.to === to && e.kind === kind)

describe('TypeScript analyzer', () => {
  it('collects functions, arrow consts, classes and methods', () => {
    expect(names('src/util.ts')).toEqual(
      expect.arrayContaining(['helper', 'arrow', 'Greeter', 'Greeter.constructor', 'Greeter.greet']),
    )
    expect(names('src/service.ts')).toEqual(expect.arrayContaining(['Service', 'Service.run', 'unused']))
  })

  it('records line ranges and JSDoc', () => {
    const helper = fragment.files
      .find((f) => f.path === 'src/util.ts')!
      .symbols.find((s) => s.name === 'helper')!
    expect(helper.line).toBe(2)
    expect(helper.endLine).toBeGreaterThan(helper.line)
    expect(helper.doc).toBe('Formats a greeting.')
  })

  it('resolves relative imports to repo files', () => {
    expect(hasEdge('src/service.ts', 'src/util.ts', 'import')).toBe(true)
    expect(hasEdge('src/index.ts', 'src/service.ts', 'import')).toBe(true)
  })

  it('resolves calls across files, including arrow consts and constructors', () => {
    expect(hasEdge('src/util.ts#arrow', 'src/util.ts#helper', 'call')).toBe(true)
    expect(hasEdge('src/util.ts#Greeter.greet', 'src/util.ts#arrow', 'call')).toBe(true)
    expect(hasEdge('src/service.ts#Service.run', 'src/util.ts#Greeter', 'call')).toBe(true)
    expect(hasEdge('src/service.ts#Service.run', 'src/util.ts#helper', 'call')).toBe(true)
    expect(hasEdge('src/index.ts#main', 'src/service.ts#Service', 'call')).toBe(true)
  })

  it('attributes module-scope calls to the file itself', () => {
    expect(hasEdge('src/index.ts', 'src/index.ts#main', 'call')).toBe(true)
  })

  it('never emits unresolved guesses', () => {
    expect(fragment.edges.every((e) => e.confidence === 'resolved')).toBe(true)
  })

  it('leaves uncalled functions edgeless rather than inventing edges', () => {
    expect(fragment.edges.some((e) => e.to === 'src/service.ts#unused')).toBe(false)
  })
})

describe('module-level objects', () => {
  it('captures a const built by a call, but not a plain object literal', () => {
    // `export const app = express()` is structure; `export const CONFIG = {...}` is data.
    expect(names('src/service.ts')).toContain('defaultService')
    expect(names('src/service.ts')).not.toContain('CONFIG')
  })

  it('gives it the variable kind', () => {
    const sym = fragment.files
      .find((f) => f.path === 'src/service.ts')!
      .symbols.find((s) => s.name === 'defaultService')!
    expect(sym.kind).toBe('variable')
  })

  it('attributes the construction call to the object, not the file', () => {
    expect(hasEdge('src/service.ts#defaultService', 'src/service.ts#Service', 'call')).toBe(true)
  })
})
