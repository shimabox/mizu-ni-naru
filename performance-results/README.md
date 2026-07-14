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

Production browser/GPU benchmark:

```sh
npm run bench:browser -- --output performance-results/raw/browser.json
```

This command builds the app, starts an isolated Vite preview, launches an isolated headless Chrome profile, and writes five 30-second rounds after a 15-second warm-up. Defaults match the fixed measurement URL and 1440×727 viewport used by the baseline. The in-app probe is enabled only by `probe=1`; normal URLs and the lightweight `m=1` overlay do not install WebGL wrappers.

The JSON contains nearest-rank distributions for rAF frame time, JS update time, draw calls, instanced draw calls, submitted vertices, `bufferSubData` bytes, `uniform4fv` bytes, and asynchronous `EXT_disjoint_timer_query_webgl2` GPU time. Raw rounds are retained, together with a median-of-round summaries block. Useful overrides are:

```sh
npm run bench:browser -- --warmup 15 --seconds 30 --rounds 5 --width 1440 --height 727
```

Set `CHROME_PATH` or pass `--chrome /absolute/path` if Chrome is not in a standard location. `--url` is restricted to localhost and automatically receives `probe=1`.

Display-refresh upload request benchmark:

```sh
npm run bench:uploads
```

This runs the fixed 60 Hz simulation behind 60, 120, and 144 Hz display schedules and counts `BufferAttribute.version` increments as GPU upload requests. Atom, Droplet, and camera-sorted Bubble attributes are reported separately. It records upload frames, requests, requested bytes, and loop wall time without requiring a browser. Use it for `view.step`/dirty-layout changes; confirm accepted changes with `bench:browser` as well.

## Per-change procedure

1. Record the current Git SHA and working-tree state.
2. Run the relevant command before changing product code.
3. Change one performance hypothesis only.
4. Run the identical command after the change.
5. Run tests and deterministic golden checks without updating expectations.
6. Add a result file named `YYYYMMDD-<slug>.md` with raw samples and the adoption decision.
7. Commit only accepted changes. Do not combine rejected work with another optimization.

Keep other browsers closed while measuring the simulation or browser benchmark. Browser/GPU measurements use a production build, fixed URL parameters, fixed viewport, and the protocol in `PERFORMANCE_REFACTORING.md`.
