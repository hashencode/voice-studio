# Fixture acquisition and review

Only manifests, recording scripts, and deterministic generators are committed.
Restricted corpora, consented recordings, decoded PCM, private references, and
the 7,200-second meeting remain under
`build/desktop_asr_comparison/fixtures/local_sources/`.

## Smoke pack

Prepare the real committed/generated smoke pack:

```bash
python3 benchmark/desktop/asr_comparison/prepare_fixtures.py
```

The tool verifies the committed Mandarin WAV/reference hashes, regenerates
silence, tone/noise, short input, and malformed input byte-for-byte, validates
16-kHz mono signed PCM, and atomically activates the pack. Repeating the command
is idempotent.

## Local-only ranked prerequisites

Before any U7 development freeze or U8 held-out execution, a corpus maintainer
must:

1. provision the declared AISHELL-4 and Common Voice subsets locally under the
   relative keys in `fixtures.json`;
2. retain the applicable license/terms record and retrieval date;
3. record consented development and held-out sessions using the committed
   scripts, assigning every speaker and recording session to only one role;
4. independently review transcripts, scenario labels, variety labels, numeric
   events, terminology events, and code-switch spans;
5. provide a real reviewed 7,200-second meeting rather than repeating the
   existing five-minute fixture;
6. decode every ranked asset to 16-kHz, mono, 16-bit signed PCM;
7. replace each pending hash/size/review/license field in a new manifest
   revision and seal it before any held-out output is inspected; and
8. run `prepare_fixtures.py --ranked`.

Common Voice clips are selected through a deterministic local subset manifest
and are not rehosted. AISHELL-4 audio is local-only. Consented recordings and
references are never committed. Published evidence contains content hashes and
bounded aggregates only.

The current manifest intentionally remains a U1-U6 implementation draft:
ranked preparation fails closed because the external/local-only prerequisites
are absent. U7 and U8 are outside this Goal.
