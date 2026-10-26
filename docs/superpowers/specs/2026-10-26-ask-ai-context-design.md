# Ask AI context and image attachments

## Intent

Make the existing Ask AI dialog show and control the context sent with a request. Support form images from both designer and code windows, plus user-selected visual references. Preserve the Win98 appearance and existing proposal/undo workflow.

## Agreed direction and approaches

Extend the current dialog incrementally, as discussed with the user. A separate settings-only solution would leave per-request choices hidden; a full chat sidebar would substantially expand this change. The existing dialog is the selected approach. No chat sidebar or agent tool execution is included.

## First version

- Keep the request text box and add a context area, optional instructions and a live attachment summary.
- In code mode offer selected code (when present), current procedure (when present) and whole code file as the work scope. Default to the existing selection, otherwise current procedure, otherwise file. Scope describes the intended edit target; retain relevant surrounding context instead of discarding needed declarations or dependencies. Align application of bare code replies with the chosen selection scope.
- In designer mode the work scope is the current form, including its existing code.
- Control names/properties and the existing project-symbol context remain automatic and are shown in the summary. This does not introduce full-project source retrieval.
- Add an include-form-picture checkbox in both modes when the active item is a form. Designer default follows the saved image preference; code default is unchecked. A standard/class module without a form cannot attach a current-form picture.
- Use the existing schematic form-image renderer, label it as such, and show a thumbnail before sending. A pixel-exact screenshot renderer is outside this first version.
- Allow up to two reference images chosen through the existing file picker (PNG/JPEG/WebP). Show thumbnails, filenames and a remove action; label them as desired appearance/reference, separately from the current form. Suggested implementation limit: 5 MiB per file, validate decoding and resize large images before sending. These exact limits are implementation choices, not requirements supplied by the user.
- Add optional instructions: make the smallest necessary change, preserve the existing layout, explain the changes. Keep fixed appearance in design properties as a form-mode instruction; do not promise that prompt instructions are enforced structural constraints.
- When explanation is requested, show a short explanation (up to three sentences) in the proposal preview. Form responses gain an optional string `explanation` field alongside `ops` and `code`, parsed separately from executable code and operations. In code mode permit and extract up to three sentences outside the code block only when requested. Update prompt instructions consistently; retain existing response behavior when the option is unchecked.
- The summary reflects selected scope, automatically included form/project context, selected form image and reference image count. Do not present an exact token count without a tokenizer.
- Per-request image choices do not overwrite saved global settings. Retain attachments during the request's repair and Change conversations, within existing server limits.
- Show known image support. Disable image attachments with an explanation when unsupported; represent unknown support honestly. If the server later rejects images or imposes a lower image limit, show which attachments were omitted before proposal acceptance. Never silently present a text-only result as having used the reference images.
- File cancellation, unreadable files or failed form-image rendering preserve the draft and existing valid attachments. Cancel closes the dialog without submitting the task.
- Keep normal validation, the best-repair selection rule, explicit proposal acceptance and undo behavior. The wizard and error-fix paths retain their existing behavior unless needed for shared compatibility.

## Constraints and non-goals

Reuse current browser/Tauri file APIs and OpenAI-compatible image message parts; no new dependencies. Keep prompts, file paths, image contents and reference text out of content-free AI diagnostics. Do not modify the running user's project while developing. Model/Thinking/token controls, clipboard paste, runtime screenshots, automatic program execution and a new multi-form output protocol are deferred.

## Verification

Exercise actual outgoing messages with mocked model replies: image enabled/disabled in both modes, reference-only code requests, combined images with labels, no-form modules, known/unknown/failed vision, reduced server image limits, cancelled file selection, invalid images, scope-aware replacement, Change and repair attachment retention, wizard compatibility and no global preference changes. Render and inspect the dialog in a browser at normal and narrow sizes. Run the AI tests and the production build. Live model quality improvements require a separate measured evaluation; local tests establish request construction and UI behavior only.

## Design review

A separate builder review identified that explanations need an explicit response format. The explanation paragraph above resolves it; no other blocking ambiguities were found.
