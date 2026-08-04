import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyzePython, type PythonResult } from '../server/analyzers/python.ts'
import { walkRepo } from '../server/walk.ts'

const ROOT = path.resolve(process.cwd(), 'fixtures/py')
let result: PythonResult

beforeAll(async () => {
  result = await analyzePython(ROOT, walkRepo(ROOT).files)
})

const names = (file: string) => result.files.find((f) => f.path === file)?.symbols.map((s) => s.name) ?? []

const edge = (from: string, to: string, kind: 'call' | 'import') =>
  result.edges.find((e) => e.from === from && e.to === to && e.kind === kind)

describe('Python analyzer', () => {
  it('parses every fixture file', () => {
    expect(result.errors).toEqual([])
    expect(result.files.map((f) => f.path).sort()).toEqual([
      'main.py',
      'pkg/__init__.py',
      'pkg/service.py',
      'pkg/util.py',
    ])
  })

  it('collects functions, classes and methods with docstrings', () => {
    expect(names('pkg/util.py')).toEqual(
      expect.arrayContaining(['helper', 'Greeter', 'Greeter.__init__', 'Greeter.greet']),
    )
    const helper = result.files
      .find((f) => f.path === 'pkg/util.py')!
      .symbols.find((s) => s.name === 'helper')!
    expect(helper.doc).toBe('Formats a greeting.')
    expect(helper.endLine).toBeGreaterThan(helper.line)
  })

  it('resolves relative and absolute imports', () => {
    expect(edge('pkg/service.py', 'pkg/util.py', 'import')).toBeTruthy()
    expect(edge('main.py', 'pkg/service.py', 'import')).toBeTruthy()
  })

  it('resolves calls to imported names', () => {
    expect(edge('pkg/service.py#run', 'pkg/util.py#helper', 'call')?.confidence).toBe('resolved')
    expect(edge('pkg/service.py#run', 'pkg/util.py#Greeter', 'call')?.confidence).toBe('resolved')
    expect(edge('main.py#main', 'pkg/service.py#run', 'call')?.confidence).toBe('resolved')
  })

  it('resolves a method call on a locally constructed object', () => {
    // `greeter = Greeter(...)` then `greeter.greet()` — one step of local type inference.
    expect(edge('pkg/service.py#run', 'pkg/util.py#Greeter.greet', 'call')?.confidence).toBe('resolved')
  })

  it('resolves self.method() against the enclosing class', () => {
    expect(
      edge('pkg/util.py#Greeter.greet', 'pkg/util.py#Greeter.uniquely_named_method', 'call')?.confidence,
    ).toBe('resolved')
  })

  it('captures module-level objects built by a call, ignoring plain constants', () => {
    // Declarative files (agents, routers, toolsets) define everything this way;
    // without it those files look empty and their diagram has nothing to draw.
    const serviceNames = names('pkg/service.py')
    expect(serviceNames).toContain('default_greeter')
    expect(serviceNames).not.toContain('PLAIN_CONSTANT') // not a call — noise, not structure
    expect(serviceNames).not.toContain('_private_thing') // private by convention
    const sym = result.files
      .find((f) => f.path === 'pkg/service.py')!
      .symbols.find((s) => s.name === 'default_greeter')!
    expect(sym.kind).toBe('variable')
  })

  it('attributes calls inside a module-level object to that object', () => {
    expect(edge('pkg/service.py#default_greeter', 'pkg/util.py#Greeter', 'call')?.confidence).toBe(
      'resolved',
    )
  })

  it('marks an untypeable attribute call as heuristic, not resolved', () => {
    const guess = edge('main.py#ambiguous', 'pkg/util.py#Greeter.uniquely_named_method', 'call')
    expect(guess?.confidence).toBe('heuristic')
  })
})

describe('src-layout repos', () => {
  const SRC_ROOT = path.resolve(process.cwd(), 'fixtures/py-src')
  let srcResult: PythonResult

  beforeAll(async () => {
    srcResult = await analyzePython(SRC_ROOT, walkRepo(SRC_ROOT).files)
  })

  it('resolves imports by package root, not repo root', () => {
    // `from app.core import compute` must find src/app/core.py, because `src`
    // holds no __init__.py and is therefore a source root, not a package.
    expect(
      srcResult.edges.find((e) => e.from === 'tests/test_core.py' && e.to === 'src/app/core.py'),
    ).toBeTruthy()
    expect(
      srcResult.edges.find(
        (e) => e.from === 'tests/test_core.py#test_compute' && e.to === 'src/app/core.py#compute',
      )?.confidence,
    ).toBe('resolved')
  })
})
