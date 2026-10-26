# AI response handling

Implement the user's six requirements for OpenAI-compatible Chat Completions. The specified Paiton model has 262144 total context tokens including input, images, reasoning and final output. Do not change server configuration, disable MTP or shrink the context as a workaround.

Extend the existing client rather than replacing the chat pipeline. Keep model reasoning in the streaming reasoning channel, never substitute it for an empty final answer. Length termination is a failed/incomplete response with explicit output-limit wording and no automatic continuation. Tool calls are parsed separately and cannot be mistaken for an empty successful answer or applied as code. This client does not execute arbitrary model tools.

Expose reasoning effort including low, medium and xhigh (retain legacy high and server-default choices); default new/missing settings to medium. Expose a positive max_tokens field, default 65536 total reasoning plus answer tokens. Keep context metadata at its actual server value; prompt budget estimates are advisory, not exact tokenization. Never remove the user-selected output cap in a retry. Stop on length; keep all other recovery bounded.

Add per-request client IDs, server request IDs, HTTP status and finish reason callbacks across browser/native streams, including JSON fallbacks and usage-only final chunks. Log IDs, model, effort, output cap, token counts including reasoning when available, duration and classified outcome. No prompt, response, reasoning, image, tool arguments, credentials or raw server error body in diagnostic log. Show actionable errors in the current operation only.

Classify length, empty answer, tool calls, interruption, cancellation, HTTP, timeout, refused connection and generic connection separately. Browser network APIs cannot reliably distinguish refusal from CORS; preserve that limit explicitly. No server changes.

Validation: automated fixtures for text, reasoning+answer, reasoning-only, truncated SSE, length with usage, tool calls and strict JSON. Verify settings persistence and privacy. Live read-only peer/model discovery plus small bounded requests only when reachable.
