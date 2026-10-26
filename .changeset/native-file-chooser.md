---
"e2e": patch
"@e2e-dev/web": patch
---

Expose an opened native file chooser as a fresh agent upload target, including
when its file input is hidden. Upload keeps the existing project-file policy;
cancelled, replaced or submitted choosers cannot be reused or relocated.
