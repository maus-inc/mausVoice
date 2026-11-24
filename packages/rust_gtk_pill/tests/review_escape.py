"""Run under xvfb-run with python3-xlib and the path to the built GTK pill."""

import json
import os
import subprocess
import sys
from pathlib import Path
from queue import Empty, Queue
from tempfile import TemporaryDirectory
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

    def belongs_to_pill(window):
        if not hasattr(window, "get_full_property"):
            return False
        pid = window.get_full_property(screen.intern_atom("_NET_WM_PID"), X.AnyPropertyType)
        return pid is not None and pid.value[0] == pill.pid

    def owns_focus():
        return belongs_to_pill(screen.get_input_focus().focus)

    def wait_visible(expected):
        deadline = monotonic() + 5
        while monotonic() < deadline:
            windows = screen.screen().root.query_tree().children
            visible = any(belongs_to_pill(w) and w.get_attributes().map_state == X.IsViewable
                          for w in windows)
            if visible == expected:
                return
            sleep(0.02)
        raise AssertionError(f"pill did not become {'visible' if expected else 'hidden'}")

    def key(name):
        assert owns_focus(), "GTK pill does not own keyboard focus"
        code = screen.keysym_to_keycode(XK.string_to_keysym(name))
        xtest.fake_input(screen, X.KeyPress, code)
        xtest.fake_input(screen, X.KeyRelease, code)
        screen.sync()

    receive("ready")
    send("request_position")
    receive("position_changed")  # The IPC loop is running, past initial show_all.
    # The default visibility is while_active. An accepted wire phase must change
    # the actual window, not just pass the shared indicator's own unit tests.
    wait_visible(False)
    send("phase", phase="recording", seq=1)
    wait_visible(True)
    send("phase", phase="idle", seq=2)
    wait_visible(False)
    send("visibility", visibility="persistent")
    set_review(None)
    deadline = monotonic() + 5
    while not owns_focus() and monotonic() < deadline:
        sleep(0.02)
    key("a")
    key("b")
    key("Escape")  # The test entry binds this to backspace.
    key("x")
    key("Return")
    typed = receive("typed_message")
    assert typed == {"type": "typed_message", "text": "ax"}, typed

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


def run_pill(binary, connection, config):
    env = {**os.environ, "GDK_BACKEND": "x11", "XDG_CONFIG_HOME": config}
    with subprocess.Popen(
        [binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        text=True, encoding="utf-8", env=env,
    ) as child:
        try:
            check(child, connection)
        finally:
            if child.poll() is None:
                child.kill()


if __name__ == "__main__":
    connection = display.Display()
    try:
        with TemporaryDirectory() as config:
            # Give an unhandled Escape an observable native GtkEntry action.
            # Only the tested child sees this binding; a swallowed key leaves "abx".
            theme = Path(config, "gtk-3.0")
            theme.mkdir()
            (theme / "gtk.css").write_text(
                '@binding-set probe { bind "Escape" { "backspace" () }; }\n'
                'entry { -gtk-key-bindings: probe; }\n', encoding="utf-8")
            run_pill(sys.argv[1], connection, config)
    finally:
        connection.close()
