# AI repair selection implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in this session.

**Goal:** Keep a repair response only when validation improves.

**Architecture:** Compare candidates in the shared conversation flow, using syntax problem count first and other problem count second. Keep the selected response, metrics and conversation history together.

**Tech Stack:** TypeScript, Vitest, jsdom.

**Spec:** User-approved design in this chat: fewer syntax errors wins; with equal syntax errors, fewer other validation problems wins; ties keep the first answer. Applies to code and forms, with at most one repair and normal preview. Change must continue from the displayed answer.

## Global constraints

- Preserve one repair attempt, explicit preview acceptance, cancellation and unreadable-response fallback.
- Do not change prompts, model settings or project files in the running app.

## Review focus

- Syntax errors outrank the number of other problems.
- Ties preserve the original proposal.
- An initially unreadable answer can still be repaired.
- Change requests use the displayed proposal's history.
- Both code and form mode use the same selection rule.

## Task 1: Select the better repair

**Files:** Modify `src/ai/askDialog.ts`, test `tests/ai/askCheck.test.ts`.

**Interfaces:** Internal comparison consumes two `readonly string[]` problem lists; existing `isSyntaxProblem` classifies compilation errors. No public API changes.

- [x] Add regression cases for worse and tied code replies, fewer semantic problems, syntax priority, worse form replies and Change history after a rejected repair.
- [x] Run `npx vitest run tests/ai/askCheck.test.ts`; confirm the new regressions fail on the old selection behavior (7 failed, 14 passed).
- [x] Add a small internal comparison and guard acceptance of the second result; retain the unreadable-first fallback.
- [x] Run the focused tests (21 passed), the full AI test directory (291 passed across 31 files) and `npm run build` (passed, existing chunk-size advisory).
- [x] Review the diff and report verification and limits. Leave changes reviewable without publishing.

**Review:** Independent reviewer found no actionable issues and independently reran all 21 focused tests successfully. Changes remain uncommitted on `codex/ai-repair-selection`; no running app or release was updated.
