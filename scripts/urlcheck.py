"""Shared HTTP(S) URL validation for the repo's developer tooling scripts."""

from urllib.parse import urlparse


def assert_http_url(url: str) -> None:
    """Reject non-http(s) URLs before handing them to urllib.

    Bandit's B310 rule flags ``urlopen``/``urlretrieve`` for allowing
    ``file:`` or custom schemes; validating the scheme here (and marking the
    call sites with ``# nosec B310``) closes that hole while keeping the
    caller simple.
    """
    scheme = urlparse(url).scheme.lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"Refusing to open non-http(s) URL: {url}")


if __name__ == "__main__":
    # Minimal self-test for the scheme allow-list.
    allowed = [
        "http://127.0.0.1:1/x",
        "https://example.com",
    ]
    rejected = [
        "file:///etc/passwd",
        "ftp://x",
    ]

    for url in allowed:
        assert_http_url(url)

    for url in rejected:
        try:
            assert_http_url(url)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Expected ValueError for non-http(s) URL: {url}")

    print("ok")
