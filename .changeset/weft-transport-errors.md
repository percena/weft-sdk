---
"@percena/weft": patch
---

Transport errors from the Flitro HTTP client now carry stable, branchable
names: a request that exceeds the configured timeout rejects with an Error
whose `name` is `'WeftTimeoutError'`, and a 2xx response whose body fails
JSON parsing rejects with an Error whose `name` is `'WeftParseError'`
(original parse error preserved on `cause`). A timeout that fires while the
body is still streaming is no longer masked as a parse error — it rethrows
as `WeftTimeoutError` so hosts branching on `error.name` see it. The errors
stay plain `Error` (not new subclasses) so existing catch logic is unaffected.

Also documents the `quota_exceeded` (HTTP 402) and
`identity_binding_required` (HTTP 403) stable codes on `WeftHttpError`, and
removes the `publishConfig.provenance` key from the manifest (provenance
attestations are minted only via the OIDC CI release workflow, not the local
break-glass publish path).
