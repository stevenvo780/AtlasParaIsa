# Desglose del `state` (T020 worktree, commit 4a227d4, semilla 51926, t=8000, 32 habitantes)

```

== cámara 12x8 · state total 311.4 KiB · people 32 · tiles 96 · events 120 · memories 5
  technology          107.7 KiB   34.6%
  people               82.7 KiB   26.6%
  events               35.6 KiB   11.4%
  organization         33.7 KiB   10.8%
  tiles                24.8 KiB    8.0%
  stats                20.8 KiB    6.7%
  blueprints            2.7 KiB    0.9%
  communities           1.1 KiB    0.4%
  memories              0.9 KiB    0.3%
  animals               0.5 KiB    0.2%
  structures            0.2 KiB    0.1%
  places                0.2 KiB    0.1%
  persona[0] por campo: experiences=825 trust=314 skills=263 traits=158 genome=97 culture=94 recentMemory=69 reason=62
  technology por campo: items=45.6K recipes=44.6K knowledge=17.0K dynamics=0.4K budgets=0.1K

== cámara 40x28 · state total 595.2 KiB · people 32 · tiles 1120 · events 120 · memories 5
  tiles               291.8 KiB   49.0%
  technology          107.7 KiB   18.1%
  people               82.7 KiB   13.9%
  events               35.6 KiB    6.0%
  organization         33.7 KiB    5.7%
  stats                20.8 KiB    3.5%
  animals              15.4 KiB    2.6%
  blueprints            2.7 KiB    0.4%
  structures            1.3 KiB    0.2%
  communities           1.1 KiB    0.2%
  memories              0.9 KiB    0.2%
  places                0.9 KiB    0.2%
  persona[0] por campo: experiences=825 trust=314 skills=263 traits=158 genome=97 culture=94 recentMemory=69 reason=62
  technology por campo: items=45.6K recipes=44.6K knowledge=17.0K dynamics=0.4K budgets=0.1K

```

Lectura: con cámara móvil (12×8) 311 KiB, dominado por `technology` (108 KiB), `people` (83 KiB: `experiences` 825 B y `trust` 314 B por persona), `events` (36 KiB), `organization` (34 KiB). Con cámara completa, `tiles` = 292 KiB (267 B/tesela por floats de 16 decimales). Dieta en T036.
