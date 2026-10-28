#!/usr/bin/env python3
"""Build a self-contained tools tree: binaries plus a complete rpath'd library closure.

For each tool binary this walks the ELF NEEDED graph, copies the real file behind
every SONAME into <out>/lib, and recreates the SONAME -> real-file symlink. A tree
built this way resolves every dependency from <out>/lib via rpath $ORIGIN/../lib,
so `env -i` with no LD_LIBRARY_PATH still works.

The previous version of this script copied only the SONAME symlinks and not their
versioned targets, which left 40 dangling links; ldd then fell back to the host's
system libraries and the closure was not actually self-contained.
"""
import os
import shutil
import subprocess
import sys

TOOLS = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tools"

LIBS = os.path.join(TOOLS, "lib")
BINS = os.path.join(TOOLS, "bin")

# Left to the host on purpose.
#
# ld-linux is chosen by the kernel from the ELF interpreter path, not by rpath, so
# a bundled copy is unreachable. The glibc family must match that host loader; a
# bundled older glibc under a newer host loader is the classic way to get bizarre
# runtime failures, and every Linux host already has glibc.
EXCLUDE = {
    "linux-vdso.so.1",
    "ld-linux-x86-64.so.2",
    "libc.so.6",
    "libm.so.6",
    "libdl.so.2",
    "libpthread.so.0",
    "librt.so.1",
    "libresolv.so.2",
    "libnsl.so.1",
    "libutil.so.1",
}

SONAME_CACHE = {}


def needed(path):
    """NEEDED entries (SONAMEs) and SONAME of an ELF, via readelf."""
    r = subprocess.run(["readelf", "-d", path], capture_output=True, text=True)
    if r.returncode != 0:
        return [], None
    names, soname = [], None
    for line in r.stdout.splitlines():
        if "(NEEDED)" in line:
            names.append(line.split("[")[1].split("]")[0])
        elif "(SONAME)" in line:
            soname = line.split("[")[1].split("]")[0]
    return names, soname


def resolve(soname):
    """Host path ld.so would use for a SONAME."""
    if soname in SONAME_CACHE:
        return SONAME_CACHE[soname]
    r = subprocess.run(["ldconfig", "-p"], capture_output=True, text=True)
    found = None
    for line in r.stdout.splitlines():
        if "=>" not in line:
            continue
        left, right = line.split("=>")
        # Format: "        libz3.so.4 (libc6,x86-64) => /lib/x86_64-linux-gnu/libz3.so.4"
        name = left.strip().split(" (")[0]
        if name == soname:
            found = right.strip()
            break
    SONAME_CACHE[soname] = found
    return found


def is_elf(path):
    try:
        with open(path, "rb") as f:
            return f.read(4) == b"\x7fELF"
    except OSError:
        return False


def main():
    os.makedirs(LIBS, exist_ok=True)

    roots = [os.path.join(BINS, n) for n in sorted(os.listdir(BINS))]
    queue = [p for p in roots if is_elf(p)]
    seen = set()
    copied = {}

    while queue:
        cur = queue.pop()
        names, _ = needed(cur)
        for soname in names:
            if soname in seen or soname in EXCLUDE:
                continue
            seen.add(soname)
            host = resolve(soname)
            if not host or not os.path.exists(host):
                print(f"  UNRESOLVED {soname}")
                continue
            real = os.path.realpath(host)
            base = os.path.basename(real)
            dest_real = os.path.join(LIBS, base)
            if not os.path.exists(dest_real):
                shutil.copy2(real, dest_real)
                os.chmod(dest_real, 0o755)
                copied[base] = soname
            link = os.path.join(LIBS, soname)
            if not os.path.lexists(link):
                os.symlink(base, link)
            queue.append(dest_real)

    print(f"copied {len(copied)} real libraries, {len(seen)} SONAMEs resolved")

    # DT_RPATH rather than DT_RUNPATH, and only on the executables.
    #
    # A DT_RUNPATH applies to one object's own lookups and is not inherited, so a
    # binary's RUNPATH finds its direct libraries but not their transitive ones,
    # which then fall back to system paths. DT_RPATH *is* inherited down the chain
    # as long as no intermediate object declares its own RUNPATH, and Debian
    # libraries do not. One tag per executable is therefore enough to make the
    # whole closure resolve from this directory, and no library has to be touched.
    #
    # That also avoids a real patchelf 0.14.3 bug: rewriting libgcc_s.so.1
    # segfaults the tool. The system patchelf is used rather than the bundled one
    # so that patchelf is not rewriting itself while it runs.
    patchelf = "/usr/bin/patchelf" if os.path.exists("/usr/bin/patchelf") else "patchelf"
    for name in sorted(os.listdir(BINS)):
        p = os.path.join(BINS, name)
        if os.path.islink(p) or not is_elf(p):
            continue
        subprocess.run([patchelf, "--force-rpath", "--set-rpath", "$ORIGIN/../lib", p], check=True)
    print("DT_RPATH $ORIGIN/../lib set on executables")

    # file(1) needs its magic database. Ship it at share/magic.mgc as a real file,
    # matching the reference branch; Debian's own /usr/share/misc symlink assumes a
    # root filesystem the consumer does not have.
    magic_src = "/usr/lib/file/magic.mgc"
    if os.path.exists(magic_src):
        share = os.path.join(TOOLS, "share")
        os.makedirs(share, exist_ok=True)
        shutil.copy2(magic_src, os.path.join(share, "magic.mgc"))
        print("magic.mgc bundled")

    broken = []
    for root, _dirs, files in os.walk(TOOLS):
        for fn in files:
            p = os.path.join(root, fn)
            if os.path.islink(p) and not os.path.exists(p):
                broken.append(p)
    print(f"broken symlinks remaining: {len(broken)}")
    for b in broken:
        print("  ", b)


if __name__ == "__main__":
    main()
