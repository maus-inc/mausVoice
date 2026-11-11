#!/usr/bin/env python3
"""Find duplicated blocks of newly added lines in this branch.

SonarCloud reports "Duplication on New Code" for the pull request, and its exact
algorithm is not reproducible here, so this is a proxy: it looks only at lines the
branch adds, and reports runs of 12 consecutive normalised lines that appear at
least twice. Blank lines and comment-only lines are ignored so a shared explanatory
comment does not count as duplicated code.

Usage: measure-new-duplication.py <base-commit>
"""
import collections
import re
import subprocess
import sys

BASE = sys.argv[1]
WINDOW = 12

diff = subprocess.run(
    ["git", "diff", "-U0", BASE], capture_output=True, text=True
).stdout
# Uncommitted work counts too, so the number matches the tree being measured.
diff += subprocess.run(["git", "diff", "-U0", BASE, "HEAD"], capture_output=True, text=True).stdout

new = collections.defaultdict(set)
path, line = None, 0
for row in diff.splitlines():
    if row.startswith("+++ b/"):
        path = row[6:]
        continue
    if row.startswith("@@"):
        line = int(re.search(r"\+(\d+)", row).group(1))
        continue
    if path and row.startswith("+"):
        new[path].add(line)
        line += 1


def load(p):
    try:
        return open(p, encoding="utf-8", errors="replace").read().splitlines()
    except FileNotFoundError:
        return []


def code(token):
    return token and not token.startswith("//") and not token.startswith("/*")


occurrences = collections.defaultdict(list)
for path in new:
    if path.endswith("Cargo.lock"):
        continue  # generated, and SonarCloud does not analyse it
    content = load(path)
    tokens = ["".join(row.split()) for row in content]
    for start in range(len(content) - WINDOW + 1):
        window = tokens[start : start + WINDOW]
        if sum(1 for token in window if code(token)) < WINDOW * 0.8:
            continue
        occurrences[tuple(window)].append((path, start + 1))

groups = collections.defaultdict(list)
for window, places in occurrences.items():
    if len(places) < 2:
        continue
    if not any(place[1] in new[place[0]] for place in places):
        continue
    groups[tuple(sorted({place[0] for place in places}))].append(places)

total = 0
for paths, found in sorted(groups.items(), key=lambda kv: -len(kv[1])):
    total += len(found) * WINDOW
    print(f"{len(found) * WINDOW:5d} lines  {paths}")
    for places in found[:3]:
        print("            ", places)
print(f"TOTAL {total} duplicated new lines")
