# Electron desktop status

## Current decision

The Audio/sidebar-09 Electron composition is development-complete and awaiting
a new U6 stable candidate. The current rail contains exactly 音频 / 互联 / 设置;
Audio and 互联 own independent context panes; Audio owns processing; and the
active storage and companion boundaries are deliberately breaking Audio v2
contracts.

The current machine-readable declaration is
`audio-sidebar-workstation.json`. The candidate prepared from revision
`590a2f088c47b235a56207420fc75ddb6501bf33` was invalidated after review exposed
false-green packaged automation and product defects. Its candidate, manual and
final receipts are preserved byte-for-byte under
`audio-sidebar-release/superseded/2026-08-18T022942Z-590a2f0-review-invalidated/`
with an explicit invalidation record; they are not current completion evidence.
A replacement candidate must bind the corrected committed source and rerun the
declared package matrix plus bounded manual session.

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

## Cloud model settings increment

The current desktop source supports multiple custom cloud model profiles. Users
can add, select, and edit profiles from a concise settings list. Each row uses a
bundled provider icon, the globally unique model ID, an optional configuration
name, and a separate selection state. Delete is available only in the edit
dialog. The selected model is read-only until another model is selected;
DeepSeek IDs require the `deepseek-` prefix without runtime rewriting.

The application generates internal profile and Keychain identities, keeps API
keys in macOS Keychain, and rejects stale mutations through the settings
revision. Key replacement and profile deletion are blocked while unfinished or
retryable work references the current secret. Failed Keychain cleanup is kept
in a minimal Main-only retry journal with no raw key material.

New AI work is prepared through a short-lived, single-use Main receipt that
freezes the model, endpoint, template, transcript scope, profile revision, and
display projection shown for consent. Generation rejects stale preparation
instead of rereading changed settings. Enqueued jobs keep the model, endpoint,
and private secret-reference identity in immutable history. The public settings
contract reserves a locked `hosted` profile shape, but no built-in platform
model is displayed or enabled in this increment.

The built-in model, membership and authentication, entitlements, quotas,
billing, the server-side inference gateway, platform credentials, and protected
server-held prompts remain a separate next-phase plan. Custom profiles continue
to use direct BYOK requests, so their client-side prompts are not claimed to be
secret.

The Privacy & Security settings module and FileVault row are no longer shown.
The backend FileVault probe and `deviceSecurity` snapshot remain intact, and are
separate from Keychain protection for provider credentials. Visual validation
for this source increment was not authorized; this section is not release
acceptance evidence and does not replace the required candidate procedure.

## Superseded U6 accessibility observation

The prior bounded manual procedure ran against the exact now-superseded package,
with no development server. Its accessibility tree and keyboard flow
exposed 音频, 互联, 设置, capture, recovery, the Audio list and detail, and the
Companion workspace with named controls, visible focus, current-page semantics,
dialog containment and restoration, and non-drag alternatives.

At 880 px and 200% text scaling, rail, capture, recovery, pane close,
processing, pairing and Audio actions remained reachable. With reduced motion
enabled, navigation and progress remained usable without motion-dependent or
color-only meaning; the original system setting was restored afterward. These
observations are retained only as diagnostic history and cannot establish
release completion for the corrected source or its future package.

The archived privacy-safe manual receipt contains only the declared check IDs,
bounded timestamps, elapsed time, operator, target fingerprint, source revision,
and package-manifest hash. A new current receipt must be produced before this
status can return to release-validated.

Flutter Desktop source remains retired and inert reference fixtures remain
historical only. Production notarization, automatic updates, and store
submission are outside this development milestone.
