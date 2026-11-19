# Causal adapter v1 — TEST_FIXTURE only

These are newly authored deterministic JSON bytes, not observations of a World.
Four independent on-disk trees contain a root bundle, treatment/control child bundles,
byte-hashed indexes, run manifests, typed protocol/registration/coverage/cuts/applications,
source-order documents, synthetic debits/effects and external fixture policy.
The tests obtain every CatalogItem from the real validateBundleFile; no manual catalog is used.

All G3 documents declare synthetic:true and every proof declares TEST_FIXTURE.
Fixture signatures use the **public RFC8032 test seed**, never a personal key.
The separate policy.fixture.json is supplied explicitly by the test harness; the adapter
never reads authority configuration from a bundle. Its first-data statements are
retrospective synthetic statements, not contemporary independent receipts.

Fixture JSON was authored by deterministic Python serialization and RFC8032 fixture
signing, without importing project code, running validators or executing test helpers.
Object keys are sorted; G1 proof bytes have no trailing newline; G3 document hashes
cover their actual newline-terminated bytes. Params/initial/input hashes derive from
authored synthetic content; sourceSHA names the staged base, not an observed run.

Cases: positive, foreign-function, function-unobserved, zero-removal. The zero-removal
tree includes an unused indexed absence proof and its exact ref for the typed-absence
negative test. No empty stream claims a physical no-service law.

Expected CPU QA: all root bundles VALID without issues, positive G1 READY with
STRUCTURAL_BINDINGS_ONLY/TEST_FIXTURE. G3 cannot resolve the qualified child evidence
reference treatment#intervention-inputs (its # syntax resolves records only).
The adapter must preserve these G3 unknowns and return UNKNOWN, not claim integration
closure. All expectations remain **UNEXECUTED** in AUTHOR ONLY.

No scientific raw reads, World, interventions, observer review, criteria derivation,
CLI overrides, four-leaf implementation or scientific acceptance occurred.

Epoch v2 repairs the authored scale from 1 to the frozen G3 window const 2400.
All dependent byte hashes and PUBLIC RFC8032 fixture signatures are regenerated.
Original 251 fixture bytes remain in a private 0600 exclusive backup.
No physical records, service amounts, authority policy, missing evidence, test
expectations, laws, criteria or validator semantics are changed. Structural QA
and any execution state are recorded separately in QA-G3-ADAPTER-FIXED-v1.
