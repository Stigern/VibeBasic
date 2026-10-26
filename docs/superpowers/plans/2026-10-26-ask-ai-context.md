# Ask AI context implementation plan

> **For agentic workers:** Use superpowers:executing-plans in this session.

**Goal:** Expose request scope, instructions, form pictures and reference attachments in Ask AI.

**Architecture:** Separate image loading and the request dialog from the shared conversation flow. Pass request-only context into the existing builders, image transport and proposal previews; preserve wizard/error paths and repair selection.

**Tech Stack:** TypeScript, browser canvas, existing Tauri/browser file APIs, Vitest/jsdom.

**Spec:** `docs/superpowers/specs/2026-10-26-ask-ai-context-design.md` (approved in chat).

## Global constraints

- No new dependencies; preserve content-free diagnostics and explicit preview acceptance.
- Two reference images at most, 5 MiB per input file, PNG/JPEG/WebP; resize to 1600 px longest edge.
- Request choices do not overwrite global preferences. Generated form picture is explicitly schematic.
- Keep one repair and the existing best-response comparison.

## Review focus

- Asynchronous image loading and detection must not submit incomplete attachments or revive a cancelled dialog.
- Code scope and bare-code replacement must agree.
- Reference labels and server fallback disclosure must match pictures actually sent.
- Explain must work with the form schema and code fences.
- Wizard, error fixes and no-form modules must remain usable.

## Task 1: Reference images

Files: `src/ai/referenceImages.ts`, `tests/ai/referenceImages.test.ts`.

- [x] Test invalid/oversized files, cancellation, decoding and resizing before implementation.
- [x] Implement `ReferenceImage {name,url}` and a file loader using the existing Backend file APIs and browser canvas.
- [x] Run its focused tests RED then GREEN (5 passed).

## Task 2: Request dialog and context

Files: `src/ai/requestDialog.ts`, `src/ai/requestDialog.css`, `tests/ai/requestDialog.test.ts`.

- [x] Test defaults, form/module availability, scope/instructions, attachment add/remove/cancel/failure, model detection and summary.
- [x] Implement an accessible responsive Win98 dialog returning a typed request, retaining the draft during attachment operations.
- [x] Run the new dialog tests RED then GREEN (7 passed; fixed index-based removal of identical attachment objects).

## Task 3: Integration, explanations and transport

Files: `src/ai/askDialog.ts`, `context.ts`, `formMode.ts`, `previewDialogs.ts`, related AI tests.

- [x] Test actual image messages in code/form modes, scope-aware edits, explanation previews, fallback visibility and global preferences.
- [x] Integrate typed dialog choices; keep original custom-prompt/error flows.
- [x] Add optional form explanation schema field and requested code prose extraction.
- [x] Run AI tests and production build; inspect the dialog in a browser at normal/narrow sizes.
- [x] Obtain independent review and address material findings; leave work reviewable without publishing.

## Verification record

- Added 21 tests: 5 image-loader, 7 dialog, 9 request-integration tests. Observed missing implementations and integration regressions failing before implementing the behavior.
- Independent reviewer found no blocking correctness issues. A minor identical-image attribution concern was reproduced as a failing role-attribution test and fixed by matching omitted image positions and labels instead of URLs. Existing rejection-disclosure coverage caught an initial overly strict label matcher; corrected it and reran the full suite.
- `npm test`: 146 files, 2,128 tests passed. `npm run build`: passed (existing Vite chunk-size advisory).
- Browser QA: real PNG decoding into an attachment, current-form thumbnail, instructions and context summary. At 390 x 700, dialog stayed within viewport, buttons remained visible, content scrolled vertically and no horizontal overflow occurred. Reset viewport afterwards.
- Screenshot saved at `/Users/stig/.codex/visualizations/2026/10/26/01a178ac-6b09-7861-81dc-31949392848d/ask-ai-context.png`.
- README updated. No new dependencies, no live LLM request, no user project edits, no app/release publication. Work remains uncommitted on `codex/ai-repair-selection` alongside the previously approved repair-selection change.

## Follow-up bug audit (user requested)

- Reproduced and fixed empty-request submission discarding attachments/scope. The same draft dialog now reopens with an inline validation message; valid resubmission retains its attachments and choices.
- Reproduced and fixed large WebP references being converted to JPEG, which cannot preserve transparency. Resized WebP and PNG now use PNG output; JPEG keeps JPEG output.
- Independent adversarial audit found unfenced VB being duplicated into the explanation panel. Reproduced and fixed: accepted unfenced code has no separate explanation; fenced replies retain their prose extraction.
- Each defect had a failing regression test before its fix. Added signature coverage for JPEG and WebP despite a misleading filename.
- Final verification: `npm test` passed all 2,133 tests across 146 files; `npm run build` and `git diff --check` passed. No live-model evaluation or installed-app rebuild was performed.
- Existing cursor-focused shortening of large code files remains unchanged: whole-file scope describes the requested edit target, while the context summary says relevant code. Full-project retrieval/context budgeting remains a separate improvement from the original investigation.

## Approved GUI refinement

User approved the GUI review recommendations: larger prompt with submit shortcut, compact labelled attachment cards, larger image viewer, compact expandable context, Ask AI button/model status and context-sensitive layout options/loading status. Keep the existing Win98 language and all request behavior.

- [x] Add behavior tests for expandable context keyboard access, image viewing/removal/draft retention, model/shortcut visibility, module layout disabling and submit/loading states.
- [x] Update `requestDialog.ts/css` and pass the model name from `askDialog.ts`. Preserve image validation and per-request choices.
- [x] Update only the initial Ask AI submission in existing automated tests; preview/other dialog OK buttons stay unchanged. The live driver needs no edit because it uses the unchanged `ok` result value instead of the visible label.
- [x] Run the AI suite and production build; inspect the real component at normal and narrow sizes; obtain an independent review.

GUI verification: new behavior tests failed before implementation; the focused dialog suite now passes 11 tests. Final full suite: 2,136 passed across 146 files; production build and diff whitespace check passed. Independent reviewer found no actionable issues. Browser QA confirmed Enter opens image preview, Escape restores the draft and focus, Enter expands details without sending, three attachment cards fit one row, and at 390 x 700 the content scrolls without horizontal overflow while Ask AI/Cancel remain visible. The normal dialog's prompt is 112 px high; normal height with three attachments is about 713 px. Screenshot: `/Users/stig/.codex/visualizations/2026/10/26/01a178ac-6b09-7861-81dc-31949392848d/ask-ai-compact.png`.

Follow-up verification requested by the user: reran all tests/build, added Enter versus Ctrl+Enter submission coverage and reproduced a focus-restoration race. When a pending attachment finished while an image viewer was open, card reconstruction detached the original focused button; closing the viewer left focus on the page body. The new failing test became green after restoring focus to the matching current button, or the prompt if its card is gone. Final focused dialog suite: 13 passed; full suite: 2,138 passed across 146 files; production build and whitespace check passed. No installed app update or live LLM request was performed.
