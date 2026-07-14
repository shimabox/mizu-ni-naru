# Performance measurement workflow

## Commands

Full simulation benchmark:

```sh
npm run bench:sim
```

The defaults reproduce the project baseline: seed 7, desktop pacing, 24 and 128 slots, 2,000 warm-up steps, 10,000 measured steps, and 7 rounds.

```sh
npm run bench:sim -- --slots 24,128 --rounds 7 --warmup 2000 --steps 10000
```

Inclusive method-boundary profile:

```sh
npm run profile:sim
```

The default profile also uses 7 rounds. Profile results include wrapper overhead and nested time. Do not add rows together. Use the output to rank targets, then use `bench:sim` for the adoption decision.

Collision detector threshold benchmark and exact compatibility check:

```sh
npm run bench:detectors
npm run verify:detectors
```

`verify:detectors` runs the Grid reference and the production detector in lockstep for seeds 7, 42, 123, and 2026, comparing counts, mass ledger, and every active render-view value at checkpoints.

## Per-change procedure

1. Record the current Git SHA and working-tree state.
2. Run the relevant command before changing product code.
3. Change one performance hypothesis only.
4. Run the identical command after the change.
5. Run tests and deterministic golden checks without updating expectations.
6. Add a result file named `YYYYMMDD-<slug>.md` with raw samples and the adoption decision.
7. Commit only accepted changes. Do not combine rejected work with another optimization.

Keep the browser closed while measuring the simulation. Browser/GPU measurements use a production build, fixed URL parameters, fixed viewport, and the protocol in `PERFORMANCE_REFACTORING.md`.
