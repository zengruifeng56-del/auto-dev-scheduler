---
name: OpenSpec: Archive
description: 归档已部署的 OpenSpec 变更并更新规格文档
category: OpenSpec
tags: [openspec, archive]
---
<!-- OPENSPEC:START -->
**Guardrails**
- Favor straightforward, minimal implementations first and add complexity only when it is requested or clearly required.
- Keep changes tightly scoped to the requested outcome.
- Refer to `openspec/AGENTS.md` (located inside the `openspec/` directory—run `ls openspec` or `openspec update` if you don't see it) if you need additional OpenSpec conventions or clarifications.

**Steps**
1. Determine the change ID to archive:
   - If this prompt already includes a specific change ID (for example inside a `<ChangeId>` block populated by slash-command arguments), use that value after trimming whitespace.
   - If the conversation references a change loosely (for example by title or summary), run `openspec list` to surface likely IDs, share the relevant candidates, and confirm which one the user intends.
   - Otherwise, review the conversation, run `openspec list`, and ask the user which change to archive; wait for a confirmed change ID before proceeding.
   - If you still cannot identify a single change ID, stop and tell the user you cannot archive anything yet.
2. Validate the change ID by running `openspec list` (or `openspec show <id>`) and stop if the change is missing, already archived, or otherwise not ready to archive.
3. Run `openspec archive <id> --yes` so the CLI moves the change and applies spec updates without prompts (use `--skip-specs` only for tooling-only work).
4. Review the command output to confirm the target specs were updated and the change landed in `changes/archive/`.
5. Validate with `openspec validate --strict` and inspect with `openspec show <id>` if anything looks off.
6. **Clean up execution directory** (Auto-Dev artifacts):
   - Scan all `openspec/execution/*/AUTO-DEV.md` files
   - For each file, check if the header contains `源自 OpenSpec: [<change-id>]` matching the archived change ID (exact match required to avoid false positives like `add-foo` vs `add-foo-2`)
   - If matched:
     a. Check task statuses: if any task is NOT `✅ 已完成`, warn the user but proceed
     b. Delete the entire `openspec/execution/<project>/` directory
     c. Remove the corresponding row from `openspec/execution/README.md` project table (the row linking to this change-id)
   - If `AUTO-DEV.md` is missing or malformed, skip and notify the user for manual cleanup

**Reference**
- Use `openspec list` to confirm change IDs before archiving.
- Inspect refreshed specs with `openspec list --specs` and address any validation issues before handing off.
- Execution directories are cleaned up automatically; no orphan folders should remain after archive.
<!-- OPENSPEC:END -->
