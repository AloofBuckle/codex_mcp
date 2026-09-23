# WebMCP verification notes

The independent default Google Chrome probe on the local fixture reported no
`navigator.modelContext` or `navigator.modelContextTesting`. Current Google
documentation uses `document.modelContext` rather than only the older navigator
location, so support detection should inspect both shapes without claiming either
is always present.

An attempt to test experimental Google Chrome feature flags through the execution tool
was blocked by the environment's safety gate. Do not repeat or route around that
blocked probe. Use ordinary runtime capability detection and a clearly identified,
opt-in compatibility shim for controlled test pages if native support is absent.
Do not claim native WebMCP compatibility merely because a shim test passes.

Primary reference reviewed:
https://github.com/GoogleChrome/modern-web-guidance-src/blob/main/guides/webmcp/webmcp/guide.md

The independent fixture registers against document.modelContext first, then the
older navigator.modelContext for compatibility.
