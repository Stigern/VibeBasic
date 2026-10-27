# New Project presets

User requested implementation of the three proposed runnable presets: Text Editor, Drawing App and Serial Terminal.

Use the existing project factory and New dialog, with native VB code and existing controls. Keep AI Wizard and the four existing templates in their current order; append the three presets. Enable required component libraries per project. No new dependencies or runtime capabilities.

- [x] Add runtime tests that execute generated projects with Option Explicit: text open/save/cancel/edit, drawing strokes/colour/width/clear, serial connect/send/receive/disconnect/error.
- [x] Implement preset builders in a separate model module, register them in templates.ts, and add original small SVG icons to the New dialog.
- [x] Update README, run targeted tests, the full TypeScript suite and production build, and review the diff.

Text Editor uses RichTextBox in plain-text mode, CommonDialog, File/Edit menus, a status line and unsaved-change confirmation. Drawing App uses an AutoRedraw PictureBox, colour and brush-size selectors and Clear. Serial Terminal accepts a port number or device name, offers common baud rates, opens only on Connect, and handles errors in its status line. Physical serial hardware verification remains a manual check.

Validation: 2147 tests pass across 147 files; production build and git diff whitespace check pass. Browser check confirmed all eight New entries and a working drawing stroke. Independent review found stale serial connection UI after device removal; added an active-connection timer and a regression test, observed RED then GREEN, and reran the full suite and build. No deferred findings.
