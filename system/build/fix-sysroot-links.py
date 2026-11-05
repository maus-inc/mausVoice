#!/usr/bin/env python3
"""Repair a `dpkg-deb -x` sysroot for use as a cross-link target.

Debian 12 is usr-merged: /lib, /bin, /sbin are symlinks into /usr. `dpkg-deb -x`
does not honour that, so it materialises real directories at those paths and the
runtime SONAMEs land off the linker search path. This script:

  1. folds lib, lib64, bin, sbin back into usr and restores the base-image symlinks;
  2. rewrites every absolute symlink to a relative one;
  3. supplies any missing symlink target from the base image (HOST) so `-lX` resolves;
  4. deletes static archives that shadow a shared library of the same name.
"""

import os
import shutil
import sys

ROOT = os.path.abspath(sys.argv[1])
HOST = os.path.abspath(sys.argv[2]) if len(sys.argv) > 2 else "/"
FOLD = ("lib", "lib64", "bin", "sbin")
BASE_LINK = {"lib": "usr/lib", "lib64": "usr/lib64", "bin": "usr/bin", "sbin": "usr/sbin"}

log = []


def merge_into(src, dst):
    """Move everything under src into dst, never clobbering an existing entry."""
    os.makedirs(dst, exist_ok=True)
    for entry in sorted(os.listdir(src)):
        s = os.path.join(src, entry)
        d = os.path.join(dst, entry)
        if os.path.islink(s):
            if os.path.lexists(d):
                continue
            os.rename(s, d)
        elif os.path.isdir(s):
            merge_into(s, d)
            os.rmdir(s)
        else:
            if os.path.lexists(d):
                continue
            shutil.move(s, d)


def fold_top(name):
    src = os.path.join(ROOT, name)
    if not os.path.isdir(src) or os.path.islink(src):
        return
    dst = os.path.join(ROOT, BASE_LINK[name])
    merge_into(src, dst)
    shutil.rmtree(src, ignore_errors=True)
    os.symlink(BASE_LINK[name], src)
    log.append(f"folded {name} -> {BASE_LINK[name]}")


def supply_from_host(relpath, dest):
    """Copy the same relative path out of the base image when it is missing here."""
    host = os.path.join(HOST, relpath)
    if not os.path.exists(host):
        return False
    real = os.path.realpath(host)
    if not os.path.exists(real):
        return False
    if os.path.isdir(real):
        os.makedirs(dest, exist_ok=True)
        log.append(f"supplied dir {relpath} from base image")
        return True
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    shutil.copy2(real, dest)
    log.append(f"supplied {relpath} from base image")
    return True


def repair_symlink(link):
    tgt = os.readlink(link)
    d = os.path.dirname(link)
    if os.path.isabs(tgt):
        real = os.path.join(ROOT, tgt.lstrip("/"))
        if not os.path.lexists(real):
            supply_from_host(tgt.lstrip("/"), real)
        rel = os.path.relpath(real, d)
        os.remove(link)
        os.symlink(rel, link)
    else:
        real = os.path.normpath(os.path.join(d, tgt))
        if not os.path.lexists(real):
            supply_from_host(os.path.relpath(real, ROOT), real)


def drop_shadowing_archives():
    removed = []
    for dirpath, _dirnames, filenames in os.walk(ROOT):
        for name in filenames:
            if not name.endswith(".a"):
                continue
            stem = name[:-2]
            shared = [f for f in (stem + ".so",) if os.path.lexists(os.path.join(dirpath, f))]
            if not shared:
                continue
            full = os.path.join(dirpath, name)
            os.remove(full)
            removed.append(os.path.relpath(full, ROOT))
    log.append(f"removed {len(removed)} static archives shadowing a .so")
    for r in sorted(removed):
        log.append(f"  rm {r}")


def main():
    for name in FOLD:
        fold_top(name)

    links = []
    for dirpath, _dirnames, filenames in os.walk(ROOT):
        for name in filenames:
            p = os.path.join(dirpath, name)
            if os.path.islink(p):
                links.append(p)
    for p in sorted(links):
        repair_symlink(p)
    log.append(f"repaired {len(links)} symlinks")

    drop_shadowing_archives()

    print("\n".join(log))


if __name__ == "__main__":
    main()
