import path from 'node:path'
import ts from 'typescript'
import type { Edge, FileInfo, IRFragment, SymbolInfo, SymbolKind } from '../types.ts'
import type { WalkedFile } from '../walk.ts'

/**
 * Parses the JS/TS files of a repo into IR symbols and edges.
 *
 * Call edges go through the TypeChecker, so a call is only recorded when it
 * resolves to a declaration we actually collected — no name matching, and
 * therefore no false edges. Everything here is `confidence: 'resolved'`.
 */
export function analyzeTypeScript(root: string, walked: WalkedFile[]): IRFragment {
  const sources = walked.filter((f) => f.lang === 'ts' || f.lang === 'js')
  if (sources.length === 0) return { files: [], edges: [] }

  const program = ts.createProgram(sources.map((f) => f.abs), compilerOptions(root))
  const checker = program.getTypeChecker()

  const relOf = new Map<string, string>() // absolute (normalized) -> repo-relative
  for (const f of sources) relOf.set(normalize(f.abs), f.path)

  const files: FileInfo[] = []
  /** declaration node -> the symbol id we minted for it, for call resolution */
  const idByDecl = new Map<ts.Node, string>()
  const edges: Edge[] = []

  // Pass 1: collect symbols so that pass 2 can resolve calls against a complete map.
  for (const src of sources) {
    const sf = program.getSourceFile(src.abs)
    if (!sf) continue
    files.push({ path: src.path, lang: src.lang, symbols: collectSymbols(sf, src.path, checker, idByDecl) })
  }

  // Pass 2: imports and calls.
  for (const src of sources) {
    const sf = program.getSourceFile(src.abs)
    if (!sf) continue
    collectImports(sf, src.path, program, relOf, edges)
    collectCalls(sf, src.path, checker, idByDecl, edges)
  }

  return { files, edges: dedupe(edges) }
}

function normalize(p: string): string {
  return path.resolve(p)
}

function compilerOptions(root: string): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    allowImportingTsExtensions: true,
  }
  // Honour the repo's own tsconfig where it exists — path aliases in particular
  // are the difference between resolving imports and silently dropping them.
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json')
  if (!configPath || !configPath.startsWith(root)) return base
  const read = ts.readConfigFile(configPath, ts.sys.readFile)
  if (read.error || !read.config) return base
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath))
  return { ...base, ...parsed.options, noEmit: true, allowJs: true, skipLibCheck: true }
}

/** True when a declaration sits at the top level of the file, not inside a function. */
function isModuleLevel(node: ts.Node): boolean {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isSourceFile(cur)) return true
    if (ts.isFunctionLike(cur) || ts.isClassLike(cur)) return false
  }
  return false
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1
}

function docOf(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  const name = (node as ts.NamedDeclaration).name
  const sym = name ? checker.getSymbolAtLocation(name) : undefined
  const text = sym ? ts.displayPartsToString(sym.getDocumentationComment(checker)).trim() : ''
  return text || undefined
}

function collectSymbols(
  sf: ts.SourceFile,
  relPath: string,
  checker: ts.TypeChecker,
  idByDecl: Map<ts.Node, string>,
): SymbolInfo[] {
  const symbols: SymbolInfo[] = []
  const used = new Set<string>()

  const add = (node: ts.Node, name: string, kind: SymbolKind, parent?: string): string => {
    // Same name twice in a file (overloads, same-named methods) — keep both, disambiguated by line.
    let unique = name
    if (used.has(unique)) unique = `${name}:${lineOf(sf, node.getStart(sf))}`
    used.add(unique)
    const id = `${relPath}#${unique}`
    symbols.push({
      id,
      name: unique,
      kind,
      line: lineOf(sf, node.getStart(sf)),
      endLine: lineOf(sf, node.getEnd()),
      doc: docOf(node, checker),
      parent,
    })
    idByDecl.set(node, id)
    return id
  }

  const visit = (node: ts.Node, classId?: string, className?: string) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node, node.name.text, 'function')
    } else if (ts.isClassDeclaration(node) && node.name) {
      const id = add(node, node.name.text, 'class')
      for (const member of node.members) visit(member, id, node.name.text)
      return
    } else if (
      (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      add(node, className ? `${className}.${node.name.text}` : node.name.text, 'method', classId)
    } else if (ts.isConstructorDeclaration(node) && className) {
      add(node, `${className}.constructor`, 'method', classId)
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        const id = add(node, node.name.text, 'function')
        // The checker resolves calls to the initializer, not the variable declaration.
        idByDecl.set(node.initializer, id)
      } else if (
        isModuleLevel(node) &&
        (ts.isCallExpression(node.initializer) || ts.isNewExpression(node.initializer))
      ) {
        // `const router = express.Router()` is structure, not a constant.
        add(node, node.name.text, 'variable')
      }
    }
    ts.forEachChild(node, (child) => visit(child, classId, className))
  }

  ts.forEachChild(sf, (node) => visit(node))
  return symbols
}

function collectImports(
  sf: ts.SourceFile,
  relPath: string,
  program: ts.Program,
  relOf: Map<string, string>,
  edges: Edge[],
): void {
  const options = program.getCompilerOptions()

  const record = (specifier: string) => {
    const resolved = ts.resolveModuleName(specifier, sf.fileName, options, ts.sys).resolvedModule
    if (!resolved) return
    const target = relOf.get(normalize(resolved.resolvedFileName))
    if (!target || target === relPath) return
    edges.push({ from: relPath, to: target, kind: 'import', confidence: 'resolved' })
  }

  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) record(node.moduleSpecifier.text)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      record((node.arguments[0] as ts.StringLiteral).text)
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sf, visit)
}

function collectCalls(
  sf: ts.SourceFile,
  relPath: string,
  checker: ts.TypeChecker,
  idByDecl: Map<ts.Node, string>,
  edges: Edge[],
): void {
  // Calls at module scope belong to the file itself rather than to any function.
  const stack: string[] = [relPath]

  const resolveTarget = (expr: ts.Expression): string | undefined => {
    let sym = checker.getSymbolAtLocation(expr)
    if (!sym) return undefined
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym)
    for (const decl of sym.declarations ?? []) {
      const id = idByDecl.get(decl)
      if (id) return id
      // `const f = () => {}` resolves to the declaration; the initializer carries the id.
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        const viaInit = idByDecl.get(decl.initializer)
        if (viaInit) return viaInit
      }
    }
    return undefined
  }

  const visit = (node: ts.Node) => {
    const ownId = idByDecl.get(node)
    if (ownId) stack.push(ownId)

    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const target = resolveTarget(node.expression)
      const from = stack[stack.length - 1]
      if (target && target !== from) {
        edges.push({ from, to: target, kind: 'call', confidence: 'resolved' })
      }
    }

    ts.forEachChild(node, visit)
    if (ownId) stack.pop()
  }

  ts.forEachChild(sf, visit)
}

function dedupe(edges: Edge[]): Edge[] {
  const seen = new Map<string, Edge>()
  for (const e of edges) {
    const key = `${e.from} ${e.to} ${e.kind}`
    const prior = seen.get(key)
    // A resolved edge always beats a heuristic duplicate.
    if (!prior || (prior.confidence === 'heuristic' && e.confidence === 'resolved')) seen.set(key, e)
  }
  return [...seen.values()]
}

/** Exposed for the merge step, which needs the same duplicate handling. */
export { dedupe }
