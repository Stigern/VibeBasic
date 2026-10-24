# VibeBasic 0.10 AI assistant: live evaluation against qwen38-27b

What the AI does in practice with the user's real local model: Qwen3.8 27B (AWQ/MXFP4) on vLLM 0.28, with structured outputs, reasoning parser and prefix caching. Measured with the harness in this folder; runs on 2026-10-24.

## How it was measured

**What runs.** `aiEval.live.ts` drives the real flows with the real `BrowserBackend` (fetch, streaming) against the server:
- `askAi` from a code window or a form designer.
- `askAiAboutError` through the real `RunController`: the program runs, stops on the error, `runtimeErrorBox` answers Ask AI, and the paused frame's variables go into the request.
- The compile-error box, Change... and Ask more....

**What is stubbed.** Only the Win98 dialogs (`driver.ts`). The stub types the prompt, waits at the waiting dialog, records every preview, answer and warning, and presses OK (or Change... / Ask more... with the scripted wish). App modules are imported fresh for every conversation, so per-session memory cannot leak between tasks.

**What is recorded per run:**
- Every request: kind, thinking level, structured output on or off, max_tokens, time, tokens, thinking length, the reply.
- Whether a proposal was shown and applied.
- The check-and-fix complaint and the warnings left in the final preview.
- Syntax errors in every module afterwards (`findSyntaxErrors`).
- Procedures or declarations lost or changed without being listed.
- Whether one undo restores the code or form and redo brings the change back.
- Loops and structured-output fallbacks.

**Behaviour checks.** For most tasks the result runs in `RunSession` with `InlineFormHost` (jsdom). Files and SaveSetting live in a `MemoryFs`, SQLite in the tests' `FakeDb`. A check types into text boxes, clicks buttons and fires menu items. It reads values back through the Immediate window. Example: with 2 and 3 in the boxes, Label1 must end in 5, and 10 + 20 must not give "1020".

**Suite.** 33 tasks in `tasks.ts`: 13 code mode, 12 form mode (one is a capability probe), 5 Ask AI on run-time errors, 3 questions.

**Runs:**
- All tasks 3x at Thinking **Low**, the user's setting.
- All tasks 2x at **Medium**.
- The 8 hard tasks 2x at **Server default**: no reasoning_effort is sent, so this model thinks at "xhigh".
- **High** could not be measured: see bug 1.
- "Fast follow-up rounds" was on, so check-and-fix and Change... rounds think at Low.

**No form picture.** node-canvas is not installed, so form mode ran with vision off. The real app sends a picture of the form.

**Supporting files:**
- `selfcheck.live.ts` shows the checks pass on hand-written correct answers.
- `probes.live.ts` reproduces the bugs offline.
- `recheck.live.ts` re-judges stored runs.
- `summarize.mjs` makes the tables.
- `results/*.jsonl` holds the raw results, with no server address in them.

**Run it:** `LIVE_BASE_URL=http://<host>:8000/v1 LIVE_MODEL=<model> LIVE_RUNS=3 LIVE_THINKING=low npx vitest run --config tests-live/vitest.config.ts tests-live/aiEval.live.ts`. The other options are in `vitest.config.ts`. Without `LIVE_BASE_URL`, only the offline self-check and probes run.

## Headline numbers

| | Low (3 runs) | Medium (2 runs) | Server default, hard only (2 runs) |
|---|---|---|---|
| all tasks (probe excluded) | 79/96 (82%) | 49/64 (77%) | 10/16 (63%) |
| code mode | 37/39 (95%) | 22/26 (85%) | 3/6 |
| form mode | 21/33 (64%) | 13/22 (59%) | 7/10 |
| Ask AI on errors | 12/15 (80%) | 8/10 (80%) | – |
| questions | 9/9 | 6/6 | – |
| proposal or answer produced | 100% | 100% | 100% |
| conversation p50 / p90 / max | 4 / 22 / 103 s | 5 / 25 / 54 s | 45 / 120 / 149 s |

- **Zero counts:** 0 "not understood", 0 JSON retries, 0 structured-output fallbacks, 0 transient retries, 0 lost user code, 0 undo failures.
- **Where failures sit:** 6 tasks account for 39 of the 47 failed runs. Each traces to one missing fact or one silently dropped value, so most are fixable in VibeBasic.
- **Thinking level:** Medium was not better than Low. Server default (xhigh) was 8–10x slower with no gain.
- **Loops:** two structured-output number runaways, both caught by the loop detector and recovered.

### Per task

| task | Low | Medium | Server | what fails |
|---|---|---|---|---|
| c-calc, c-validate, c-file, c-settings, c-timer, c-dict, c-fib, c-compile, c-explain-change, c-change | 30/30 | 20/20 | – | |
| c-class (Person class with Property Let/Get, then used from a form) | 3/3 | 2/2 | 2/2 | |
| c-chart (bar chart with Line BF and ScaleMode) | 3/3 | 0/2 | 1/2 | wrong Scale syntax; the retry never fixes it |
| c-ado (ADO on SQLite into a ListView) | 1/3 | 0/2 | 0/2 | ListSubItems (438), ListItems(0) (35600), `Set x = f , , y` |
| f-login (then Change...: fixed dialog, centred) | 0/3 | 0/2 | – | StartUpPosition 4 silently ignored |
| f-calc (calculator layout) | 3/3 | 1/2 | 2/2 | once a truncated answer (1 TextBox, no buttons) was applied |
| f-menu, f-entry, f-bars, f-messy, f-cancel | 15/15 | 10/10 | – | |
| f-sstab | 0/3 | 0/2 | 1/2 | Tabs given as captions, silently ignored |
| f-tabstrip | 0/3 | 0/2 | 1/2 | `SelectedItem = 1` / `Select Case SelectedItem` |
| f-mdi (menus on an existing MDIForm) | 0/3 | 0/2 | 1/2 | WindowList on an empty sub-item, or set in code (383) |
| f-datagrid | 3/3 | 2/2 | 2/2 | |
| f-mdi-new (capability probe, not counted) | 0/3 | 0/2 | – | no op can add a form |
| e-div0, e-subscript, e-nothing, e-nofile | 12/12 | 8/8 | – | 3/5 div0 fixes just set `count = 1` |
| e-mismatch (error 13 from `age = Text1.Text` with "twelve") | 0/3 | 0/2 | – | always `CInt(Text1.Text)`: still error 13 |
| q-what, q-why13, q-mdi | 9/9 | 6/6 | – | Low's why13 answers contain a false VB6 claim |

## Latency

All 206 Low/Medium requests: p50 4.7 s, p90 22.5 s, p99 40 s, max 85 s. Conversations: p50 5.4 s, p90 28 s, max 102 s. 48% finish under 5 s, 69% under 10 s, 95% under 40 s.

| thinking | category | conversation p50 | p90 | max | first request p50 | p90 |
|---|---|---|---|---|---|---|
| Low | code | 3.1 s | 8.0 | 12.7 | 2.5 | 7.8 |
| Low | form | 16.9 s | 55.0 | 102.5 | 14.2 | 34.5 |
| Low | error | 2.7 s | 3.9 | 4.2 | 2.5 | 3.7 |
| Low | question | 5.0 s | 10.4 | 10.4 | 5.0 | 10.4 |
| Medium | code | 4.7 s | 16.9 | 21.8 | 3.6 | 14.5 |
| Medium | form | 16.3 s | 38.6 | 53.7 | 16.3 | 28.7 |
| Server default | code (hard) | 37.3 s | 80.4 | 80.4 | 18.4 | 26.9 |
| Server default | form (hard) | 54.1 s | 149 | 149 | 50.9 | 149 |

| request kind | Low: n / p50 / p90 / completion tokens / thinking chars | Medium | Server default |
|---|---|---|---|
| first | 102 / 4.0 s / 22.4 s / 766 / 1,899 | 68 / 5.6 / 22.7 / 915 / 2,198 | 18 / 30.3 / 104.2 / 3,859 / 11,915 |
| check-and-fix | 13 / 11.1 / 27.0 / 1,943 / 4,127 | 6 / 10.2 / 29.1 / 1,558 / 3,071 | 6 / 26.0 / 54.9 / 2,886 / 8,165 |
| Change... | 6 / 3.4 / 4.9 | 4 / 3.3 / 3.5 | – |
| Ask more... | 3 / 1.7 / 1.7 | 2 / 2.8 / 2.8 | – |
| loop retry | 2 / 14.1 | – | – |

- **Prompt size:** about 9,500 tokens; the system prompt is 32–35 KB.
- **Cache hits are invisible:** the server never reports cached tokens. vLLM's `--enable-prompt-tokens-details` would show whether the prefix cache hits.
- **Why form mode is slow:** its answers are long JSON (2,000–4,000 tokens with thinking), and 13–38% of them get a check round of another 10–30 s.

## The check-and-fix round

| | conversations | with a check round | fixed all problems | problems left | loops | SO fallbacks |
|---|---|---|---|---|---|---|
| Low | 99 | 13 (13%) | 12 | 1 | 2 | 0 |
| Medium | 66 | 6 (9%) | 4 | 2 | 0 | 0 |
| Server default | 16 | 6 (38%) | 4 | 2 | 0 | 0 |

**What the first round complained about:**

| complaint | count |
|---|---|
| control outside the form (half by 240 twips or less) | 26 |
| caption doesn't fit / control too small | 18 |
| overlap | 9 |
| syntax | 5 |
| negative position | 3 |
| unknown member ("A Data has no Open method.") | 3 |
| MDIForm_ event name | 1 |

**Outcome:** layout complaints were fixed almost every time; syntax complaints 0 of 5 times.

## Top failure patterns

**1. Form mode silently drops values it cannot use, and the retry never hears about it.** `parseFormOps` turns a bad value into a grey warning. `runFormConversation` builds the complaint only from the code validator, skipped stubs, renames and the layout check. Examples:
- f-sstab, every run: `"Tabs":"General\nView\nAdvanced"` gives "Ignored invalid value for Tabs", and the tabs end up captioned "Tab 0, Tab 1, Tab 2".
- f-sstab, one Low run: `"props":{"tab":1}` gives "Ignored unknown property tab" six times, so every control lands on tab 0 and they overlap.
- f-login, every run: `"StartUpPosition":4` is ignored. StartUpPosition is in `NAME_ONLY_ENUMS`, so the prompt never lists its values.
- An OptionButton got `"Value":1` (invalid; it expects a Boolean).
- `{"op":"set","name":"Form1",...}` gives "Ignored change to missing control Form1."

**2. Facts missing from, or wrong in, the reference:**
- TabStrip: the model wrote `(TabStrip1.SelectedItem = 1)` and `Select Case TabStrip1.SelectedItem / Case 0`. The card never says SelectedItem is a Tab with a 1-based `.Index`.
- ListView: `item.ListSubItems.Add` (error 438; only `SubItems(i)` exists) and `ListItems(i)` starting at 0 (error 35600).
- Scale: `Scale 0, 0, 10, 10` and `Scale (0, 8), (4, 0)`; the card never shows the `(x1, y1)-(x2, y2)` form for Scale.
- WindowList: put on an empty-caption sub-item, or set in code (error 383).
- ADO: the control list says "there is no New ADODB.Connection" while the language card lists `New: ADODB.Connection`.

**3. Syntax complaints the model can't act on.** The complaint "Line 17: Expected: -" for `Picture1.Scale (0, 8), (4, 0)` was read as the Line method. The model rewrote the Line call and left Scale alone. OK then applied code that doesn't compile. The same happened with c-ado's `Set li = ListView1.ListItems.Add , , rs("Name")`.

**4. Less common controls are weak.** c-ado, f-tabstrip and f-mdi pass 1/7 each: the model falls back on half-remembered VB6.

**5. Error fixes hide the symptom.**
- e-mismatch, 5/5: the request shows only `age = 0`, not `Text1.Text = "twelve"`, and every fix is `CInt(...)`, which still fails.
- e-div0, 3/5: `count = 1` was inserted before the division.

**6. Form mode can't add forms.** The MDIForm add and the `set Form1 MDIChild` were both ignored. The menus and code were applied to Form1 itself, leaving a half-done result.

**7. Smaller observations:**
- A truncated structured answer (4 ops ending in `"leftOf":"x"`) was applied as a calculator with no buttons.
- `disable_any_whitespace` is not honoured by this server.
- Number runaways: `"top":2400000000…`.
- A Top in props beats the place's cross axis, which the prompt doesn't explain; Command2 went to Top 0 and overlapped until the retry.
- Low claimed that VB6 doesn't convert strings to numbers for arithmetic (wrong; Medium got it right).
- `isQuestion` misses "How do I...", but prose replies were still shown as answers (5/5).

## Bugs in VibeBasic's AI code

1. **Thinking High is rejected by this server** with "Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low." There is no fallback (16/16 runs failed).
2. **Form-mode parse warnings are not fed back as problems.**
3. **"set" with the form's own name is dropped.** If it is the only op, the whole answer becomes "not understood".
4. **A changed module-level declaration is added next to the old one.** It happens for both Dim and Const. VibeBasic runs it (the later one wins); VB6 would report "Duplicate declaration". *(Fixed on fix/ai-review.)*
5. **The system prompt contradicts itself** on `New ADODB.Connection`. *(Fixed on fix/ai-review.)*
6. **Syntax complaints have no statement text** and "Line N" is ambiguous with the Line method; they were fixed 0/5 times. After a failed retry, OK still applies code that doesn't compile.
7. **An empty-content reply falls back to the thinking text** (`answerText` / `reply_text`). Code mode then extracts ```vb blocks drafted while thinking. A risk only, not seen live.
8. **Members of `As Object` variables are not validated**, which let ListSubItems through to run time.
9. **NAME_ONLY_ENUMS like StartUpPosition carry no values** in the prompt.
10. **The fix request lacks the value on the failing line.**

No bugs were found in procedure merging, undo/redo, the schema, the loop detector or trimming.

## Ranked suggestions

1. **Feed parse warnings back with the valid values.** For example: "StartUpPosition 4 is not valid (0 Manual, 1 CenterOwner, 2 CenterScreen, 3 WindowsDefault)", "SSTab Tabs is the count; put the captions in TabCaption", "form mode cannot add an MDIForm".
2. **Be lenient where the intent is clear:**
   - A "set" naming the form itself becomes a form op.
   - `props.tab` becomes the op-level tab.
   - 1/0 becomes True/False for Boolean properties.
   - Multi-line Tabs text becomes TabCaption plus the count.
3. **Map Thinking High to a level the server accepts.** On a 400 that lists the supported levels, retry with the nearest one and remember it per server. Better: show the supported levels after Test Connection.
4. **Make syntax complaints actionable.** Quote the statement and give the expected form, e.g. "In `Picture1.Scale (0, 8), (4, 0)`: Scale takes (x1, y1)-(x2, y2)". If a syntax error survives the retry, show it in red or make Cancel the default.
5. **Add card idioms** (about 400 characters):
   - `Set it = ListView1.ListItems.Add(, , "t"): it.SubItems(1) = "x"` (ListItems count from 1).
   - `TabStrip1.SelectedItem.Index`.
   - `Picture1.Scale (x1, y1)-(x2, y2)`.
   - WindowList belongs on the top-level menu and is design-time only.
   - A Data control set up in code needs `Data1.Refresh`.
6. **Fix requests: evaluate the failing line's operands in the paused frame and ask for a real fix.** Show e.g. `Values on the failing line: Text1.Text = "twelve"`, and say "handle this value; don't just set a variable to make the error disappear".
7. **Replace an existing declaration of the same name** instead of adding a duplicate. *(Done on fix/ai-review.)*
8. **Auto-grow the form for small overflows** (240 twips or less) instead of a model round. Also tell the model that a Left/Top in props wins over "place".
9. **Bound the integers in FORM_OPS_SCHEMA** (minimum/maximum) and add maxLength to strings.
10. **Add new ops:** `newForm` (including MDI forms) and code into standard or class modules.
11. **Validator:** infer types from known factories (`ListItems.Add` gives a ListItem, `CreateObject("ADODB.Recordset")` gives a Recordset), or recommend typed variables.
12. **Detect truncated structured answers** and degenerate placements like `"leftOf":"x"`.
13. **Smaller things:** give StartUpPosition, WindowState and BorderStyle their values in the prompt; extend `isQuestion` with "how do I / can I / can you / is this"; enable vLLM's prompt-tokens details.

## Default thinking levels

| mode | recommendation | evidence |
|---|---|---|
| code mode | Low | 95% vs 85%; p50 3 s vs 5 s |
| Ask AI on errors | Low | 80% at both; needs suggestion 6, not more thinking |
| questions | Low (Medium if accuracy matters) | 100% at both; Low once made a false VB6 claim |
| form mode | Low | 64% vs 59% at the same ~16 s; xhigh 70% on hard tasks at 3x the time |
| follow-up rounds | keep Low | Change... 3 s, Ask more... 2 s |

The new-user default "Server default" means xhigh on this model (45–150 s). Suggest Low as the default when Test Connection finds a model that supports reasoning_effort, and offer High only if the server accepts it.

## Limits of this evaluation

- **Vision off.** The app's real form-mode requests carry a picture, so their speed, loops and layout quality may differ.
- **Browser backend, not Tauri.** The request body is the same in `ai.rs` (temperature, reasoning_effort, structured_outputs, max_tokens).
- **Two runs in parallel.** Low and Medium ran side by side on a server that takes two sequences, so latency includes some queueing.
- **Small samples.** 2–3 runs per task and level make the per-task numbers indicative; the pattern counts are the robust part.
- **Check leeway.** Behaviour checks allow some freedom ("Result: 5" counts as 5). Form inspections check structure, not taste.
