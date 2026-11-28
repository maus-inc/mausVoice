# The vendored autotools are not relocatable and need a root copy to FHS paths

Date: 2026-11-05
Status: accepted

## Context

The third payload delivery (G16 to G22) was first recorded with `autoconf`,
`bison` and `flex` but without `automake`, `libtool` or `m4`, while
`engineering/sandbox-vendored-toolchain.md` and the branch `FETCH.md` both claimed
automake and libtool shipped. A reader who followed those documents ran
`autoreconf -i` and hit `Can't locate Automake/Config.pm in @INC`, then
`exec: /usr/bin/autom4te: not found`.

Two separate things were wrong. The binaries were missing, and the run
instructions assumed the group could be made to work the same way every other
group does, by putting `system/tools/bin` on `PATH` and setting an environment
variable for the compiled-in path. That assumption does not hold for the
autotools.

## Decision

Ship the whole chain in `system/tools`: `autoconf` 2.71, `automake` 1.16.5,
`libtoolize` 2.4.7, `m4` 1.4.19, the Perl scripts `autom4te`, `autoheader`,
`aclocal-1.16` and `automake-1.16`, and the support trees `share/autoconf`,
`share/aclocal`, `share/aclocal-1.16`, `share/automake-1.16` and `share/libtool`.

Document the group as the one non-relocatable group, and give the root copy in
`FETCH.md` step 7f rather than an environment variable. Each tool reads its macro
and library trees from a path compiled in at build time, and `autoconf` execs
`/usr/bin/autom4te`. No single variable redirects all of them. The step copies the
support trees to `/usr/share/...` and the scripts to `/usr/bin`, then the round
trip runs under `env -i` with only the tools directory on `PATH`.

Rejected: a relocatable route through `ACLOCAL_PATH`, `AUTOMAKE_LIBDIR` and
`autom4te --include`. It covers some tools and not others, and it does not fix the
`exec: /usr/bin/autom4te` call.

## Consequences

A sandbox that needs to build a `configure`-based dependency must run the step 7f
copy, which needs root. The measured cost is the five support trees plus eight
scripts. In exchange the whole chain works: on 2026-11-05 `autoreconf -i` wrote
`configure` and `Makefile.in`, `./configure` exited 0, `make` linked `./t` and the
binary ran, all under `env -i`.

The four `config.guess` and `config.sub` links in the automake and libtool trees
pointed at `share/misc`, outside the shipped tree, so they were broken in the
payload. They were repaired by shipping `share/misc` rather than by dropping the
links, because `configure` needs `config.guess` to identify the build host.
