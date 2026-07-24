# tkt-10-publish-npm-skill

> **TL;DR:** Deliver `/publish-npm` project skill with next/latest channels, auto|exact|bump versions, dual-package filters, and safe local-publish gates.
> **Kind:** feat · **Status:** open · **Priority:** P2
> **Path:** spc-9 → tkt-10 → pr-11

| Field | Value |
| --- | --- |
| kind | feat |
| priority | P2 |
| labels | feat, P2 |
| github | https://github.com/percena/weft-sdk/issues/10 |
| status | open |
| adopted | false |
| summary | /publish-npm skill for @percena/weft + weft-node local release |
| spec | spc-9 — publish-npm skill (path: ../../specs/spc-9-publish-npm-skill.md) |
| covers | A1, A2, A3, A4, A5, A6, A7, A8 |
| blocked_by | (none) |
| parallel_group | (serial) |
| paths | `.claude/skills/publish-npm/**`, `.gitignore` (lattice block), `.lattice/specs/spc-9-*`, `.lattice/tickets/tkt-10-*` |
| solo_merge | yes |
| **primary_ticket** | tkt-10 |
| **related_tickets** | (none) |
| **worktree_bind** | `spc-9-publish-npm-skill` |
| worktree | sibling `…/weft-sdk.worktrees/spc-9-publish-npm-skill/` |
| prs | pr-11 — https://github.com/percena/weft-sdk/pull/11 |

## Acceptance (this slice)

- [ ] **A1** Skill invokable as `/publish-npm` (`.claude/skills/publish-npm/SKILL.md`)
- [ ] **A2** Channels next/latest + modes auto|exact|bump; auto-next never burns patch solely to iterate
- [ ] **A3** Interactive package select (weft / weft-node / both); independent version lines
- [ ] **A4** Gate order: main → rebuild → validate/test → provenance toggle → dry-run → confirm → publish → restore
- [ ] **A5** `--filter` only; never unfiltered `pnpm run release`
- [ ] **A6** Version commit + apps align; push only on second confirm
- [ ] **A7** Gotchas documented + enforced in runbook/script
- [ ] **A8** Plan/dry-run mode without unrestored provenance mutation

## Notes

Single delivery ticket under spc-9. Ship as one-PR with lattice `.gitignore` init residue.

## References

- GitHub issue body is SoT for long prose
- Spec: `spc-9` → `../../specs/spc-9-publish-npm-skill.md`
- Analog: weftd `deploy-weftd-flitro` skill shape (confirm / dry-run / scripts)

## Lineage

- Parent spec: **spc-9**
- Parent issue (GH sub-issue of Spec primary): **#9**
- Primary ticket: **tkt-10**
- Related / sub-tickets: (none)
- Covers: **A1–A8**
- Blocked by: (none)
- Parallel group: serial
- Worktree bind: `spc-9-publish-npm-skill`
- Child PRs: pr-11 — https://github.com/percena/weft-sdk/pull/11

## Assets

Local files in `./assets/`.

## Finish

- (none yet)
