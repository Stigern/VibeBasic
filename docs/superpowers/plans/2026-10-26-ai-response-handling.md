# AI Response Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Correct reasoning, configurable output limits, failure reporting and content-free diagnostics.
**Architecture:** Extend existing string result API with typed metadata/tool callbacks. Keep final text and reasoning separate; reject incomplete or tool-only results in the current text/JSON consumer.
**Tech Stack:** TypeScript, Tauri/Rust, Vitest, local HTTP fixtures.
**Spec:** docs/superpowers/specs/2026-10-26-ai-response-handling-design.md

## Global Constraints
- Server context stays 262144; no server/MTP configuration changes.
- Medium default; low/medium/xhigh selectable; output cap explicitly adjustable, default65536.
- No automatic length continuation or retry without output cap.
- No sensitive contents in diagnostics.

## Review Focus
- Reasoning-only stop must fail, not become an answer.
- Usage-only terminal chunks must not overwrite finish_reason.
- Dropped streams with partial content must be incomplete, not successful.
- HTTP errors must retain status metadata without content in logs.
- Tool calls must remain separate from final text and not execute implicitly.

## Tasks
- [x] Native transport: write failing fixtures for termination/metadata/tools/errors; implement bounded parsing and telemetry, retain existing public wrappers where feasible; run Rust suite.
- [x] Settings: failing persistence/UI tests; add xhigh, medium default and validated maxTokens; bounded budget integration; run settings and request tests.
- [x] Browser/native adapter: failing fixtures; metadata, tool callbacks and exact completion semantics; run backend tests.
- [x] Conversation/logging: failing tests for privacy, no-retry length/cap errors, empty final failure; implement safe diagnostics and bounded retries; run full TS suite.
- [ ] Independent review, native UI verification, build and GitHub synchronization/publication of updated release after all checks.

## Verification evidence
- Full TypeScript suite: 2097 passed. Native suite: 148 passed. TypeScript/frontend build passed.
- Independent review found parity/length-priority defects; all fixed with regressions and re-reviewed clear.
- Read-only Tailscale discovery found the server at 100.106.183.31:8000; GET /models reports paiton-flashnext-vision, context262144. LAN URL timed out.
- Three small live requests (medium, max_tokens1024): text stop (18 input/31 output/27 reasoning), strict JSON stop (19/37/30, valid JSON), tool call (270/41/23, one call and no final text). No tool was executed. No server configuration changed.

- Packaged macOS app0.11.2 verified in a separate app instance: Medium, 65536-token budget, opt-in fast follow-up and selectable XHigh. Existing running calculator project and saved AI settings were not changed.
