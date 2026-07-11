"""Seed data: 3-role users, the payment-service CMDB subgraph, the SLA matrix.

The CMDB is the spine of both demo workflows: payment-service depends on
payment-db + api-gateway + redis-cache, and runs on payment-server. A P1 on
payment-service traverses ``depends_on``/``runs_on`` to triage.
"""
from __future__ import annotations

SEED_USERS: list[dict] = [
    {"id": "u1", "username": "alice", "role": "agent", "on_call_for": ["ci1", "ci2", "ci5"]},
    {"id": "u2", "username": "bob", "role": "manager", "on_call_for": []},
    {"id": "u3", "username": "carol", "role": "requester", "on_call_for": []},
    {"id": "u4", "username": "dave", "role": "agent", "on_call_for": ["ci3", "ci4"]},
]

SEED_CIS: list[dict] = [
    {"id": "ci1", "name": "payment-service", "type": "application", "owner": "alice",
     "status": "in_service", "depends_on": ["ci2", "ci3", "ci4"], "runs_on": ["ci5"]},
    {"id": "ci2", "name": "payment-db", "type": "database", "owner": "alice",
     "status": "in_service", "depends_on": [], "runs_on": ["ci5"]},
    {"id": "ci3", "name": "api-gateway", "type": "application", "owner": "dave",
     "status": "in_service", "depends_on": [], "runs_on": ["ci5"]},
    {"id": "ci4", "name": "redis-cache", "type": "application", "owner": "dave",
     "status": "in_service", "depends_on": [], "runs_on": ["ci5"]},
    {"id": "ci5", "name": "payment-server", "type": "server", "owner": "alice",
     "status": "in_service", "depends_on": [], "runs_on": []},
    {"id": "ci6", "name": "web-frontend", "type": "application", "owner": "carol",
     "status": "in_service", "depends_on": ["ci3"], "runs_on": []},
]

SEED_SLAS: list[dict] = [
    {"id": "sla1", "priority": "P1", "response_mins": 15, "resolution_mins": 60},
    {"id": "sla2", "priority": "P2", "response_mins": 60, "resolution_mins": 240},
    {"id": "sla3", "priority": "P3", "response_mins": 240, "resolution_mins": 1440},
    {"id": "sla4", "priority": "P4", "response_mins": 1440, "resolution_mins": 4320},
]
