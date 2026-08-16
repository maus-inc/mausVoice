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
