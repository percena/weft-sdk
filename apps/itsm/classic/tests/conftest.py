"""Pytest fixtures: isolated store + TestClient + login helper.

The store is a module singleton; ``isolated_state`` resets it (and the
in-memory sessions) before + after each test so cases are independent.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import auth
from app.main import app
from app.store import store


@pytest.fixture(autouse=True)
def isolated_state():
    store.reset()
    auth.sessions.clear()
    yield
    store.reset()
    auth.sessions.clear()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def login():
    def _login(client: TestClient, username: str):
        r = client.post("/api/auth/login", json={"username": username})
        assert r.status_code == 200, r.text
        return r.json()
    return _login
