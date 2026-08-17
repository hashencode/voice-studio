# Electron desktop status

## Current decision

The Audio/sidebar-09 Electron composition is a development-complete candidate
whose U6 release validation is **pending**. It must not inherit PASS from the
earlier workstation package. The current rail contains exactly 音频 / 互联 /
设置; Audio and 互联 own independent context panes; Audio owns processing; and
the active storage and companion boundaries are deliberately breaking Audio
v2 contracts.

The current machine-readable declaration is
`audio-sidebar-workstation.json`. It records no source revision, package hash,
automated receipt, or manual receipt until U6 prepares one committed stable
candidate. Any product, behavior, or package change after preparation requires
a new candidate. Finalization must verify the original source and package
identity and must not rebuild.

## Historical closure

The earlier macOS Electron workstation closure remains historical PASS under
its `DEVELOPMENT_ONLY` gate. Its package, resources, target, automated receipts,
and bounded VoiceOver receipt are hash-bound in the existing historical
manifests. Those immutable artifacts continue to prove the completed earlier
milestone only; they are not current Audio/sidebar-09 acceptance evidence and
must not be rewritten.

macOS remains the only current desktop target. Windows is
`DEFERRED_OUT_OF_CURRENT_SCOPE`; a future Windows effort must repeat its own
install, package, capability, accessibility, privacy, and artifact validation.

## U6 accessibility procedure

Run the procedure only against the exact packaged candidate prepared by U6,
with no development server. Enable VoiceOver and navigate exclusively by
keyboard through 音频, 互联, 设置, capture, recovery, the Audio list, selected
Audio detail, and selected-device detail. Confirm spoken names and states,
visible focus, current-page semantics, dialog containment and restoration, and
non-drag alternatives.

At 880 px and at 200% text scaling, verify that rail, capture, recovery, pane
close, processing, pairing, history, and transfer actions remain reachable.
Enable reduced motion and confirm that navigation and progress remain usable
without motion-dependent or color-only meaning. Verify fresh Audio database
reset messaging and a clear pre-mutation rejection for an old peer.

The privacy-safe manual receipt must contain the declared check IDs, start and
finish timestamps, elapsed time, target fingerprint, source revision, and
package-manifest hash. It must not contain user paths, transcript text, audio,
credentials, tokens, screenshots with user data, or free-form operator notes.
After recording the result, finalize against the unchanged candidate without
rebuilding.

Flutter Desktop source remains retired and inert reference fixtures remain
historical only. Production notarization, automatic updates, and store
submission are outside this development milestone.
