# Electron desktop status

## Current decision

macOS Electron closure is **BLOCKED** under the `DEVELOPMENT_ONLY` U12 gate.
Windows remains `BLOCKED_BY_MACOS_CLOSURE`; no macOS result has been reused for
Windows and U13 has not started.

The packaged macOS application, native helper, workers, runtimes, models,
resource manifest, dependency lock, source revision, target fingerprint,
signatures, and frozen Flutter reference fixtures are hash-bound in
`desktop-electron-evidence.json`. The root `./tool/dev_check.sh`, Electron static
checks, current package creation, package smoke, and U11 companion restart/resume
gate passed on the declared Apple M2 target.

Closure is not declared because the complete U6-U11 product-flow set has not
been recaptured against the single current package manifest, and the locked GUI
prevented the bounded VoiceOver/minimum-window/200%-scaling/reduced-motion
accessibility procedure from being executed. Test definitions are present and
hash-bound, but definitions are not execution evidence.

## Required to unblock macOS

1. Run `tool/check_electron_desktop.sh` from the bound source revision and retain
   privacy-safe execution receipts for every packaged flow.
2. On the same target and package manifest, execute the bounded accessibility
   procedure `macos-voiceover-navigation-v1` within ten minutes and record PASS
   for keyboard, focus, VoiceOver, minimum window size, 200% text scaling,
   reduced motion, and non-drag alternatives.
3. Regenerate the evidence bindings and change macOS to `PASS` only after
   `tool/validate_electron_desktop_scope.py` accepts the complete record.

## Bounded accessibility procedure

`macos-voiceover-navigation-v1` has a ten-minute limit and must use the same
target fingerprint and package manifest as the automated receipts. Start the
packaged application with no development server, enable VoiceOver, and use only
the keyboard to visit Library, Tasks, Capture, Companion, Settings, and one
meeting workspace. Confirm visible focus, spoken names and states, dialog focus
containment and restoration, and non-drag alternatives. At the minimum window
size and at 200% text scaling, confirm that every action remains reachable.
Enable reduced motion and confirm that navigation and progress remain usable
without motion-dependent meaning. Record the seven exact check IDs from the
machine evidence, start and finish timestamps, elapsed time, target hash, and
package hash in a privacy-safe manual receipt. Do not record paths, transcript
text, audio, credentials, tokens, screenshots with user data, or free-form
operator notes.

Flutter Desktop remains reference source only. It was not launched, its runtime
profile was not inspected or migrated, and it is not a runtime fallback or a
shared database. Production notarization, automatic updates, store submission,
and a release-candidate device matrix are outside this development milestone.
