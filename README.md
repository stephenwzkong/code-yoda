# code-yoda

Visualize a codebase as an interactive Mermaid diagram. Point it at a local folder or a
GitHub URL, drill from folders down to files and functions, and click any block to read
the code beside the chart.

Supports **Python** and **JavaScript/TypeScript**.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173  (PORT=… to change)
```

Then enter a path (`/Users/me/code/my-project`) or a URL
(`https://github.com/psf/requests`) and press **Analyze**.

Requires Node 20+, `python3` on PATH (set `PYTHON` to override), and `git` for GitHub URLs.
Private repos work through your existing git credentials — there is no token to configure.

```bash
npm test             # analyzer, projection and diagram tests
npm run typecheck
npm run build && npm start   # production build
```

## How it works

The diagram never shows the whole repo at once. It renders **one level at a time**:

| Scope | Nodes | Edges |
| --- | --- | --- |
| root | top-level folders | every underlying import/call between them, aggregated with a count |
| a folder | its immediate children (subfolders collapsed, files expanded) | as above |
| a file | that file's functions, classes and methods | calls, plus stub nodes for calls crossing the file boundary |

Clicking a **folder** drills in. Clicking a **file** drills in *and* opens its source.
Clicking a **function** opens it in the panel without moving the diagram. Any level past
~60 nodes folds its least-connected nodes into a `+N more` node you can click to expand.

The side panel shows highlighted source scrolled to the symbol, its docstring, and
**Callers**/**Callees** lists that navigate the graph — plus an *Open in VS Code* link.

## Edge confidence

Every edge is either `resolved` or `heuristic`, and the difference is visible: heuristic
edges are dashed in the diagram and tagged `guess` in the panel.

- **TypeScript/JavaScript** — calls are resolved through the TypeScript `TypeChecker`, so
  every edge is `resolved`. A call that does not resolve is dropped rather than guessed.
- **Python** — resolved covers module-local calls, imported names, `self.method()`, and
  `x = SomeClass()` followed by `x.method()`. Anything else (`obj.method()` on a value of
  unknown type) falls back to a repo-wide unique name match and is marked `heuristic`.
  When the receiver is a known import that resolves outside the repo — `winreg.OpenKey()`
  — no edge is emitted at all, since guessing there only invents false links.

Import resolution honours a repo's own `tsconfig.json` (path aliases included) and Python
package roots, so a `src/` layout resolves `requests.utils`, not `src.requests.utils`.

## Layout

```
server/
  index.ts              Express API + Vite middleware
  ingest.ts             local path or GitHub URL -> a directory on disk
  walk.ts               source-file discovery, skip rules, size cap
  analyze.ts            runs both analyzers, merges the IR, caches by content hash
  graph.ts              IR -> one readable level (pure; heavily tested)
  types.ts              the IR shared by both analyzers
  analyzers/
    typescript.ts       ts.Program + TypeChecker
    python.ts           spawns the helper below
    python/analyze.py   stdlib `ast`, no pip install
src/                    React UI: chart pane, side panel, search, breadcrumbs
fixtures/               small ts/ and py/ repos the analyzer tests assert against
```

Analyses are cached in `.cache/` keyed by a hash of file sizes and mtimes, so re-analyzing
an unchanged repo is instant and editing a file invalidates it.

## Known limits

- Python attribute calls on values of unknown type can only be name-matched; see above.
- Repos over 3000 source files are truncated with a warning naming the largest folders —
  point code-yoda at a subfolder for a complete graph.
- The panel is read-only. Use *Open in VS Code* to edit.
