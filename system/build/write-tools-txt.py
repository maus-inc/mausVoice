#!/usr/bin/env python3
"""Write system/tools/TOOLS.txt: <filename>\t<package>\t<version> for every tool and closure library.

dpkg on usr-merged Debian records a library under the path it was installed to,
which for libc and friends is /lib/x86_64-linux-gnu/... even though /lib is a
symlink to /usr/lib. A naive single-path `dpkg -S` therefore misses those files
and reports their origin as "apt". Each candidate path is tried in both the
usr-merged and the unmerged form, which is what makes the lookup order matter.
"""
import os
import subprocess
import sys

TOOLS = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tools"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/out/system/tools/TOOLS.txt"

SEARCH_BASES = (
    "/usr/bin", "/usr/sbin", "/usr/lib/x86_64-linux-gnu", "/usr/lib", "/usr/libexec",
    "/bin", "/sbin", "/lib/x86_64-linux-gnu", "/lib",
)

MERGES = (
    ("/lib/", "/usr/lib/"),
    ("/usr/lib/", "/lib/"),
    ("/bin/", "/usr/bin/"),
    ("/usr/bin/", "/bin/"),
    ("/sbin/", "/usr/sbin/"),
    ("/usr/sbin/", "/sbin/"),
)


def variants(path):
    """Yield the usr-merged and unmerged forms of an absolute path."""
    yield path
    for src, dst in MERGES:
        if path.startswith(src):
            yield dst + path[len(src):]


def pkg_of(paths):
    for p in paths:
        r = subprocess.run(["dpkg", "-S", p], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.split(":")[0].split(",")[0].strip()
    return None


def ver(pkg):
    r = subprocess.run(["dpkg-query", "-W", "-f=${Version}", pkg], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else "unknown"


index = {}
for base in SEARCH_BASES:
    if not os.path.isdir(base):
        continue
    for root, _dirs, files in os.walk(base):
        for fn in files:
            index.setdefault(fn, []).append(os.path.join(root, fn))

rows = []
for sub in ("bin", "lib"):
    d = os.path.join(TOOLS, sub)
    if not os.path.isdir(d):
        continue
    for n in sorted(os.listdir(d)):
        p = os.path.join(d, n)
        real = os.path.realpath(p)
        candidates = []
        for base in index.get(n, []):
            candidates.extend(variants(base))
        if os.path.exists(real):
            candidates.extend(variants(real))
        pk = pkg_of(dict.fromkeys(candidates))
        rows.append((n, pk or "apt", ver(pk) if pk else "unknown"))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    for n, p, v in sorted(set(rows)):
        f.write(f"{n}\t{p}\t{v}\n")

unresolved = [r for r in sorted(set(rows)) if r[1] == "apt"]
print(f"wrote {len(set(rows))} rows to {OUT}, unresolved: {len(unresolved)}")
for r in unresolved:
    print("  unresolved:", r[0])
