# Build scripts

The three scripts that produced the derived parts of this payload. They are shipped so
a future maintainer can reproduce or adjust the tree instead of guessing at it. Nothing
in `FETCH.md` runs them; a consumer only extracts what they produced.

| Script | Produces | Run as |
| --- | --- | --- |
| `fix-sysroot-links.py` | the repaired `debian12-dev-sysroot` tree, before it is tarred | `python3 fix-sysroot-links.py /tmp/gtk-sysroot` |
| `build-tools-closure.py` | `system/tools/lib` and the `DT_RPATH` tags on `system/tools/bin` | `python3 build-tools-closure.py /tmp/tools` |
| `write-tools-txt.py` | `system/tools/TOOLS.txt` | `python3 write-tools-txt.py /tmp/tools /out/system/tools/TOOLS.txt` |

Run order in a `debian:12` container: install the apt set, extract the `.deb` files with
`dpkg-deb -x` into `/tmp/gtk-sysroot`, run `fix-sysroot-links.py` against it, tar it.
Separately copy the four tool binaries and their cmake share tree into `/tmp/tools`, run
`build-tools-closure.py` against it, then `write-tools-txt.py`.

Two things these scripts encode that cost real time to learn.

`fix-sysroot-links.py` exists because Debian 12 is usr-merged but `dpkg-deb -x` creates
real `lib`, `bin` and `sbin` directories, which puts runtime SONAMEs off the linker
search path. It folds those into `usr`, relativises absolute symlinks, fills in missing
symlink targets from the base image, and deletes static archives that shadow a shared
library of the same name.

`build-tools-closure.py` sets `DT_RPATH`, not `DT_RUNPATH`, and only on the executables.
`DT_RUNPATH` is not inherited, so a binary's runpath finds its direct libraries but not
their transitive dependencies, which then fall back to system paths and make the tree
look self-contained when it is not. It also uses the system `patchelf` rather than the
bundled one, because `patchelf` 0.14.3 segfaults rewriting `libgcc_s.so.1` and cannot
rewrite itself while running.
