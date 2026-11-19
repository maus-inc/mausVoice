"""Run under xvfb-run with python3-xlib and the path to the built GTK pill."""

import json
import os
import subprocess
import sys
from queue import Empty, Queue
from threading import Thread
from time import monotonic, sleep

from Xlib import X, XK, display
from Xlib.ext import xtest


def check(pill, screen):
    events = Queue()

    def read_stdout():
        for line in pill.stdout:
            events.put(json.loads(line))
        events.put(None)

    Thread(target=read_stdout, daemon=True).start()

    def send(kind, **fields):
        print(json.dumps({"type": kind, **fields}), file=pill.stdin, flush=True)

    def receive(kind):
        deadline = monotonic() + 6
        while monotonic() < deadline:
            try:
                msg = events.get(timeout=max(0, deadline - monotonic()))
            except Empty:
                break
            if msg is None:
                raise RuntimeError(f"pill exited before {kind}")
            if msg["type"] == kind:
                return msg
            if msg["type"] in ("review_decision", "typed_message", "assistant_close"):
                raise AssertionError(f"unexpected IPC while waiting for {kind}: {msg}")
        raise AssertionError(f"timed out waiting for {kind}")

    def set_review(review):
        send("assistant_state", active=True, input_mode="type", compact=False,
             conversation_id="fixture", messages=[], permissions=[], review=review)
        # The input queue is FIFO. Wait for a reply to the following command.
        send("request_position")
        receive("position_changed")

    def owns_focus():
        window = screen.get_input_focus().focus
        if not hasattr(window, "get_full_property"):
            return False
        pid = window.get_full_property(screen.intern_atom("_NET_WM_PID"), X.AnyPropertyType)
        return pid is not None and pid.value[0] == pill.pid

    def key(name):
        assert owns_focus(), "GTK pill does not own keyboard focus"
        code = screen.keysym_to_keycode(XK.string_to_keysym(name))
        xtest.fake_input(screen, X.KeyPress, code)
        xtest.fake_input(screen, X.KeyRelease, code)
        screen.sync()

    receive("ready")
    send("visibility", visibility="persistent")
    set_review(None)
    deadline = monotonic() + 5
    while not owns_focus() and monotonic() < deadline:
        sleep(0.02)
    key("Escape")
    key("x")
    key("Return")
    assert receive("typed_message") == {"type": "typed_message", "text": "x"}

    set_review({"id": "edit", "text": ""})
    key("x")
    key("Return")
    assert receive("review_decision") == {
        "type": "review_decision", "review_id": "edit", "action": "insert", "text": "x",
    }

    set_review({"id": "old", "text": "first"})
    set_review({"id": "current", "text": "second"})
    key("Escape")
    assert receive("review_decision") == {
        "type": "review_decision", "review_id": "current", "action": "cancel",
    }
    set_review(None)  # Also rejects a duplicate decision queued before the ack.
    send("quit")
    assert pill.wait(timeout=3) == 0


if __name__ == "__main__":
    connection = display.Display()
    try:
        with subprocess.Popen(
            [sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, encoding="utf-8", env={**os.environ, "GDK_BACKEND": "x11"},
        ) as child:
            try:
                check(child, connection)
            finally:
                if child.poll() is None:
                    child.kill()
    finally:
        connection.close()
