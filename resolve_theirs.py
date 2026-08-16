import sys, re, pathlib

def resolve_theirs(path: str) -> None:
    p = pathlib.Path(path)
    text = p.read_text()
    if "<<<<<<<" not in text:
        return
    # Split into conflict blocks. Use a state machine.
    out = []
    lines = text.split("\n")
    i = 0
    n = len(lines)
    changed = 0
    while i < n:
        line = lines[i]
        if line.startswith("<<<<<<<"):
            # find ======= and >>>>>>>
            j = i + 1
            while j < n and not lines[j].startswith("======="):
                j += 1
            k = j + 1
            while k < n and not lines[k].startswith(">>>>>>>"):
                k += 1
            # theirs = lines[j+1 .. k-1]
            theirs = lines[j+1:k]
            out.extend(theirs)
            changed += 1
            i = k + 1
        else:
            out.append(line)
            i += 1
    p.write_text("\n".join(out))
    print(f"{path}: resolved {changed} conflict region(s) to theirs")

for f in sys.argv[1:]:
    resolve_theirs(f)
