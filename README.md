# Flight Log Lab

Browser-based launch-log analyser: drop CSV logs (any flight computer) and CATS Vega `.cfl` files from one launch, get apogee, velocity, acceleration, burnout, descent rates, events, GPS drift and board comparisons. Includes a Claude assistant when hosted as a claude.ai artifact.

## Layout
- `src/core.js` — parsers (CSV, CATS binary), column auto-detection, unit conversion, flight analysis. Pure JS, no DOM; testable in Node (`node test.js`).
- `src/app.js` — UI: file loading/merging, charts (uPlot), tabs, column-mapping editor, profiles, export, assistant tools.
- `src/template.html` — page shell and CSS.
- `build.js` — bundles everything (plus uPlot) into a single `dist/index.html`.

## Build
```
npm install
node build.js        # -> dist/index.html (open directly in a browser)
node test.js         # runs the analysis on sample logs and prints results
```

## Adding a new board format
1. Most CSVs need nothing — names like `t_ms`, `alt`, `pressure`, `ax`, `gps_lat` are recognised (`NAME_RULES` in `core.js`).
2. For unusual names, fix them once in the "Columns" dialog and choose "Apply & remember this layout".
3. For a new binary format, add a `looksLikeX` / `parseX` pair next to `parseCATS` that returns `{columns, rows, events}`.
