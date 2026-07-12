"""SPA static serve must not allow path traversal out of the web root.

The SPA fallback route only mounts when ``dist/`` exists, so this builds a real
``dist/`` at the app root (plus a sentinel file one level above it — where the
app's ``.env`` lives), reloads ``app.main`` so the route registers, asserts that
percent-encoded ``../`` cannot escape the web root, then restores the module.
"""
from __future__ import annotations

import importlib
import shutil

from fastapi.testclient import TestClient


def test_percent_encoded_traversal_is_blocked():
    import app.main as main
    from pathlib import Path

    web_dist = Path(main.__file__).resolve().parent.parent / "dist"
    secret = web_dist.parent / "spa_traversal_sentinel.env"
    created_dist = not web_dist.exists()
    try:
        web_dist.mkdir(parents=True, exist_ok=True)
        (web_dist / "index.html").write_text("<html>spa</html>")
        (web_dist / "app.js").write_text("console.log(1)")
        secret.write_text("WEFT_API_KEY=leaked")

        main = importlib.reload(main)
        client = TestClient(main.app)

        assert client.get("/app.js").status_code == 200

        for attack in ("/..%2fspa_traversal_sentinel.env",
                       "/%2e%2e/spa_traversal_sentinel.env",
                       "/..%2f..%2fspa_traversal_sentinel.env"):
            r = client.get(attack)
            assert "leaked" not in r.text, f"{attack} leaked a file above the web root"
    finally:
        secret.unlink(missing_ok=True)
        (web_dist / "app.js").unlink(missing_ok=True)
        (web_dist / "index.html").unlink(missing_ok=True)
        if created_dist:
            shutil.rmtree(web_dist, ignore_errors=True)
        importlib.reload(main)
