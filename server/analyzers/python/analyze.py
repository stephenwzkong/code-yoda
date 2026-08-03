"""Extract symbols and edges from a set of Python files.

Reads a JSON job on stdin:  {"root": "/abs/repo", "files": ["a/b.py", ...]}
Writes an IR fragment on stdout: {"files": [...], "edges": [...], "errors": [...]}

Only the standard library is used, so there is nothing to install. Import and
module-local call edges are `resolved`; attribute calls (`obj.method()`) can
only be matched by name, so they are reported as `heuristic` and the caller
renders them as guesses.
"""
import ast
import json
import os
import sys


def module_name(rel_path):
    """`pkg/mod.py` -> `pkg.mod`; `pkg/__init__.py` -> `pkg`."""
    no_ext = rel_path[:-3] if rel_path.endswith(".py") else rel_path
    if no_ext.endswith(".pyi"):
        no_ext = no_ext[:-4]
    parts = no_ext.split("/")
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(p for p in parts if p)


def importable_name(rel_path, package_dirs):
    """The name a file is imported by, which is relative to its package root.

    A `src/` layout is the common case: `src/requests/utils.py` is imported as
    `requests.utils`, not `src.requests.utils`, because `src` holds no
    `__init__.py` and so is a source root rather than a package.
    """
    parts = rel_path.split("/")
    dirs, filename = parts[:-1], parts[-1]
    i = len(dirs)
    while i > 0 and "/".join(dirs[:i]) in package_dirs:
        i -= 1
    return module_name("/".join(dirs[i:] + [filename]))


def docstring_of(node):
    try:
        doc = ast.get_docstring(node)
    except TypeError:
        return None
    if not doc:
        return None
    first = doc.strip().split("\n\n")[0].strip()
    return first[:400] if first else None


def end_line(node, fallback):
    return getattr(node, "end_lineno", None) or fallback


class FileScan:
    """Symbols, imports and raw call sites for a single module."""

    def __init__(self, rel_path, tree):
        self.rel_path = rel_path
        self.symbols = []
        self.by_name = {}          # local name -> symbol id (module-level defs)
        self.import_targets = []   # module names this file imports
        self.alias_to_module = {}  # local alias -> module name
        self.alias_to_symbol = {}  # local alias -> (module name, original name)
        self.calls = []            # (enclosing id, kind, payload, owner class id)
        self.local_types = {}      # (enclosing id, var name) -> constructor name
        self._scan(tree)

    def _add(self, node, name, kind, parent=None, top_level=False):
        unique = name
        if any(s["name"] == unique for s in self.symbols):
            unique = "%s:%d" % (name, node.lineno)
        sym_id = "%s#%s" % (self.rel_path, unique)
        self.symbols.append({
            "id": sym_id,
            "name": unique,
            "kind": kind,
            "line": node.lineno,
            "endLine": end_line(node, node.lineno),
            "doc": docstring_of(node),
            "parent": parent,
        })
        if top_level:
            self.by_name[name] = sym_id
        return sym_id

    def _scan(self, tree):
        self._walk_body(tree.body, enclosing=self.rel_path, class_id=None,
                        class_name=None, top_level=True, owner_class=None)

    def _walk_body(self, body, enclosing, class_id, class_name, top_level, owner_class):
        for node in body:
            self._walk_node(node, enclosing, class_id, class_name, top_level, owner_class)

    def _walk_node(self, node, enclosing, class_id, class_name, top_level, owner_class):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            kind = "method" if class_id else "function"
            name = "%s.%s" % (class_name, node.name) if class_name else node.name
            sym_id = self._add(node, name, kind, parent=class_id, top_level=top_level)
            # A nested def is not a method, but `self` inside it still refers to
            # the class we are lexically inside — hence owner_class carries down.
            self._walk_body(node.body, enclosing=sym_id, class_id=None, class_name=None,
                            top_level=False, owner_class=class_id or owner_class)
            return

        if isinstance(node, ast.ClassDef):
            sym_id = self._add(node, node.name, "class", top_level=top_level)
            self._walk_body(node.body, enclosing=sym_id, class_id=sym_id, class_name=node.name,
                            top_level=False, owner_class=sym_id)
            return

        if isinstance(node, ast.Assign):
            self._record_assignment(node, enclosing)
        elif isinstance(node, ast.Import):
            for alias in node.names:
                self.import_targets.append(alias.name)
                self.alias_to_module[alias.asname or alias.name.split(".")[0]] = alias.name
        elif isinstance(node, ast.ImportFrom):
            module = self._resolve_from(node)
            if module is not None:
                self.import_targets.append(module)
                for alias in node.names:
                    if alias.name == "*":
                        continue
                    self.alias_to_symbol[alias.asname or alias.name] = (module, alias.name)

        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.Call):
                self._record_call(child, enclosing, owner_class)
            self._walk_node(child, enclosing, class_id, class_name, False, owner_class)

    def _resolve_from(self, node):
        """Turn `from ..pkg import x` into an absolute module name."""
        if not node.level:
            return node.module
        here = module_name(self.rel_path).split(".")
        # level 1 = current package, so drop the module itself plus level-1 more.
        drop = node.level - 1
        base = here[:-1]
        if drop:
            base = base[:-drop] if drop <= len(base) else []
        if node.module:
            base = base + node.module.split(".")
        return ".".join(base) if base else None

    def _record_assignment(self, node, enclosing):
        """`x = SomeClass(...)` — the only local type inference we attempt."""
        if not isinstance(node.value, ast.Call):
            return
        ctor = node.value.func
        if isinstance(ctor, ast.Name):
            ctor_name = ctor.id
        elif isinstance(ctor, ast.Attribute):
            ctor_name = ctor.attr
        else:
            return
        for target in node.targets:
            if isinstance(target, ast.Name):
                self.local_types[(enclosing, target.id)] = ctor_name

    def _record_call(self, call, enclosing, owner_class):
        func = call.func
        if isinstance(func, ast.Name):
            self.calls.append((enclosing, "name", func.id, owner_class))
        elif isinstance(func, ast.Attribute):
            base = func.value
            if isinstance(base, ast.Name):
                self.calls.append((enclosing, "attr", (base.id, func.attr), owner_class))
            else:
                self.calls.append((enclosing, "method", func.attr, owner_class))


def build(root, rel_paths):
    scans = {}
    errors = []
    for rel in rel_paths:
        abs_path = os.path.join(root, rel)
        try:
            with open(abs_path, "r", encoding="utf-8", errors="replace") as handle:
                tree = ast.parse(handle.read(), filename=abs_path)
        except SyntaxError as exc:
            errors.append({"path": rel, "message": "syntax error line %s" % exc.lineno})
            continue
        except OSError as exc:
            errors.append({"path": rel, "message": str(exc)})
            continue
        scans[rel] = FileScan(rel, tree)

    package_dirs = set()
    for rel in scans:
        if rel.endswith("/__init__.py"):
            package_dirs.add(rel[: -len("/__init__.py")])
        elif rel == "__init__.py":
            package_dirs.add("")

    # Package-root names win; the repo-root name is kept as a fallback so that
    # flat layouts and `tests.helpers`-style imports still resolve.
    module_to_path = {}
    for rel in scans:
        module_to_path.setdefault(module_name(rel), rel)
    for rel in scans:
        module_to_path[importable_name(rel, package_dirs)] = rel

    # name -> [symbol id]; used only for the attribute-call heuristic, and only
    # when the name is unambiguous across the whole repo.
    by_simple_name = {}
    for rel, scan in scans.items():
        for sym in scan.symbols:
            simple = sym["name"].split(".")[-1]
            by_simple_name.setdefault(simple, []).append(sym["id"])

    edges = []

    def add(src, dst, kind, confidence):
        if src and dst and src != dst:
            edges.append({"from": src, "to": dst, "kind": kind, "confidence": confidence})

    for rel, scan in scans.items():
        for module in scan.import_targets:
            target = resolve_module(module, module_to_path)
            if target and target != rel:
                add(rel, target, "import", "resolved")

        def name_to_symbol(name):
            """A bare name in this file: module-local def, or something imported."""
            local = scan.by_name.get(name)
            if local:
                return local
            imported = scan.alias_to_symbol.get(name)
            if imported:
                return symbol_in_module(imported[0], imported[1], module_to_path, scans)
            return None

        for enclosing, kind, payload, owner_class in scan.calls:
            if kind == "name":
                target = name_to_symbol(payload)
                if target:
                    add(enclosing, target, "call", "resolved")
                else:
                    heuristic(enclosing, payload, by_simple_name, add)
                continue

            if kind != "attr":
                heuristic(enclosing, payload, by_simple_name, add)
                continue

            base, attr = payload

            # `self.method()` — the class we are lexically inside is known.
            if base == "self" and owner_class:
                target = method_of(owner_class, attr, scans)
                if target:
                    add(enclosing, target, "call", "resolved")
                    continue

            # `x = SomeClass(); x.method()` — one step of local type inference.
            ctor = scan.local_types.get((enclosing, base))
            if ctor:
                owner = name_to_symbol(ctor)
                target = method_of(owner, attr, scans) if owner else None
                if target:
                    add(enclosing, target, "call", "resolved")
                    continue

            # `import pkg.mod` then `mod.func()`.
            module = scan.alias_to_module.get(base)
            if module:
                target = symbol_in_module(module, attr, module_to_path, scans)
                if target:
                    add(enclosing, target, "call", "resolved")
                    continue

            # `from pkg import mod` then `mod.func()`, or an imported class's method.
            owner = name_to_symbol(base)
            if owner:
                target = method_of(owner, attr, scans) or symbol_in_module_path(owner, attr, scans)
                if target:
                    add(enclosing, target, "call", "resolved")
                    continue

            # The base is an import we could not resolve inside the repo, so the
            # target lives in a third-party or stdlib module. Guessing here just
            # invents edges to same-named local symbols (`winreg.OpenKey`).
            if base in scan.alias_to_module or base in scan.alias_to_symbol:
                continue

            heuristic(enclosing, attr, by_simple_name, add)

    files = [
        {
            "path": rel,
            "lang": "py",
            "symbols": [
                {k: v for k, v in sym.items() if v is not None or k not in ("doc", "parent")}
                for sym in scan.symbols
            ],
        }
        for rel, scan in sorted(scans.items())
    ]
    return {"files": files, "edges": edges, "errors": errors}


def heuristic(enclosing, name, by_simple_name, add):
    """Attribute/unknown call: accept only an unambiguous repo-wide name match."""
    candidates = by_simple_name.get(name, [])
    if len(candidates) == 1:
        add(enclosing, candidates[0], "call", "heuristic")


def resolve_module(module, module_to_path):
    """Longest-prefix match, so `pkg.sub.mod` finds `pkg/sub/mod.py` or `pkg/sub/__init__.py`."""
    parts = module.split(".")
    while parts:
        candidate = module_to_path.get(".".join(parts))
        if candidate:
            return candidate
        parts = parts[:-1]
    return None


def symbol_in_module(module, name, module_to_path, scans):
    """`from pkg.mod import thing` -> the id of `thing` inside pkg/mod.py."""
    rel = module_to_path.get(module)
    if rel is None:
        # `from pkg import mod` — the name may itself be the module.
        rel = module_to_path.get("%s.%s" % (module, name))
        if rel is not None:
            return rel
        return None
    scan = scans.get(rel)
    if scan is None:
        return None
    return scan.by_name.get(name)


def symbol_in_module_path(owner, attr, scans):
    """`from pkg import mod` resolves `mod` to a file path; find `attr` inside it."""
    if "#" in owner:
        return None
    scan = scans.get(owner)
    return scan.by_name.get(attr) if scan else None


def method_of(owner_id, attr, scans):
    """Given a class symbol id, find `Class.attr` in the same file."""
    if "#" not in owner_id:
        return None
    rel, class_name = owner_id.split("#", 1)
    scan = scans.get(rel)
    if scan is None:
        return None
    wanted = "%s.%s" % (class_name, attr)
    for sym in scan.symbols:
        if sym["name"] == wanted:
            return sym["id"]
    return None


def main():
    job = json.load(sys.stdin)
    result = build(job["root"], job["files"])
    json.dump(result, sys.stdout)


if __name__ == "__main__":
    main()
