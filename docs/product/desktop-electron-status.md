# Electron desktop status

## Current decision

macOS Electron closure is **PASS** under the `DEVELOPMENT_ONLY` U12 gate.
Windows is `READY_FOR_INDEPENDENT_U13`; no macOS result is reused for Windows,
and U13 must produce its own target-specific package and product-flow evidence.

The packaged macOS application, native helper, workers, runtimes, models,
resource manifest, dependency lock, source revision, target fingerprint,
signatures, and frozen Flutter reference fixtures are hash-bound in
`desktop-electron-evidence.json`. The root `./tool/dev_check.sh`, Electron static
checks, fresh package creation, package smoke, and every automated U6-U11
product-flow gate passed against one package manifest on the declared Apple M2
target. Each automated result has a privacy-safe, source/package/target-bound
execution receipt under `docs/product/electron-closure-receipts/`.

The bounded `macos-voiceover-navigation-v1` procedure also passed against the
same target and package manifest in 315,351 ms. VoiceOver, keyboard navigation,
visible focus, dialog containment and restoration, minimum-window operation,
200% text scaling, reduced motion, and non-drag alternatives were observed in
the packaged application. The temporary VoiceOver and reduced-motion settings
were restored after the session.

## Next target gate

U13 may now begin on Windows hardware or an approved Windows target environment.
It must repeat install, package, process-tree, native capability, feature,
accessibility, privacy, and packaged-artifact validation without importing this
macOS PASS.

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
