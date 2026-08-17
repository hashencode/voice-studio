# Processing sidecar tools

`launcher.py` is the product-shaped process boundary. It starts a new process
session, applies CPU, file-size, descriptor, and core-dump limits, then replaces
the inherited environment with a minimal allowlist. The desktop supervisor
samples worker RSS and terminates the process group at the frozen memory limit.
AI-provider and pairing secrets are never forwarded.

`worker.py` implements protocol v1 over JSONL on stdin/stdout. It never opens a
network listener. Inputs use a verified path relative to the job root and are
re-hashed before model loading. FunASR and pyannote load only pre-provisioned
model roots; their processing environment sets both Hugging Face and
ModelScope to offline mode.

On macOS the desktop supervisor additionally launches this boundary through a
deny-network sandbox profile and kills the complete worker process group on
cancel, timeout, output limit, or resource violation.
