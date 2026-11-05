# Flight Log Lab

Flight data analyser for **WhiteNoise NTUA** launches. Drop in the log files from every board on a flight (ACB, DLT, CATS Vega, …) and get apogee, max velocity/Mach, acceleration, burnout, descent rates, flight events, GPS drift and a side-by-side comparison of all boards.

**Live site:** https://whitenoise-ntua.github.io/Flight-Log-Lab/

Everything runs in your browser. Log files are never uploaded anywhere.

---

## Using the site

1. Open the live site (or `docs/index.html` locally — see below).
2. Drag **all log files from one launch** onto the page at once (or click the upload box).
   - Any CSV/TSV from a flight computer
   - CATS Vega binary logs (`.cfl`)
3. The site automatically:
   - detects what every column is (time, altitude, pressure, accelerometer, GPS, states, pyro outputs, …) and its units,
   - **merges files that share a clock** into one board (e.g. DLT `rest.csv` + `imu.csv`),
   - attaches event logs to their board (e.g. ACB `recovery_events.csv`),
   - aligns all boards on their own detected liftoff (T+0).
4. Rename each board by clicking its name (e.g. `altlog` → `ACB`). The name is remembered for files with the same columns.
5. If a column was guessed wrong, click **Columns** on that board, fix it, then **Apply & remember this layout** so next launch loads correctly.

### Tabs

| Tab | What it shows |
|---|---|
| **Overview** | Key numbers, board comparison table, findings & data-quality warnings |
| **Flight plots** | Altitude, velocity, acceleration, pressure — all boards overlaid |
| **Board sensors** | Every sensor per board: gyro, IMU axes, temperature, battery, states, pyro channels, airbrake command, flags |
| **Events** | Timeline of detected and logged events (liftoff, burnout, apogee, deployments, …) |
| **GPS track** | Ground track, landing position, drift distance |
| **Channel explorer** | Plot any channel(s) from any board |

Tips: drag on a chart to zoom, double-click to reset. Use **Boost / Ascent / Whole flight / Full log** to change the time range.

### Sharing column profiles with the team

Profiles (column fixes + board names) are saved in your browser only. To share them: **Profiles → Copy JSON**, send it to a teammate, and they paste it in **Profiles → Import**.

---

## Running it locally

### Just open it
No install needed — open the built page in a browser:

```bash
start docs/index.html        # Windows (Git Bash)
open docs/index.html         # macOS
xdg-open docs/index.html     # Linux
```

or double-click `docs/index.html` in your file explorer.

### Developing
Requires [Node.js](https://nodejs.org/) (v18+).

```bash
git clone https://github.com/WhiteNoise-Ntua/Flight-Log-Lab.git
cd Flight-Log-Lab
npm install          # one time: downloads uPlot (charts), the Anthropic SDK and esbuild
node build.js        # bundles src/ into dist/index.html
```

Open `dist/index.html` to test your changes. After each edit in `src/`, run `node build.js` again and refresh the browser.

To test the analysis without the UI, put launch logs in a `sample-data/` folder (it is git-ignored) and run:

```bash
node test.js sample-data/
```

---

## Publishing an update to the live site

The live site is served by GitHub Pages from the `docs/` folder on `main`.

```bash
node build.js
cp dist/index.html docs/index.html
git add -A
git commit -m "Describe your change"
git push
```

The site updates about a minute after the push (watch the **Actions** tab).

---

## Project structure

```
src/core.js         Parsers (CSV, CATS .cfl), column auto-detection, unit conversion, flight analysis
src/app.js          User interface: loading/merging files, charts, tabs, column editor, profiles, export
src/template.html   Page layout and styles
src/claude-sdk.js   Entry point that bundles the official Anthropic SDK for the browser
build.js            Bundles everything (incl. uPlot and the Anthropic SDK) into one self-contained dist/index.html
test.js             Runs the analysis on log files in a folder and prints the results
docs/index.html     Published copy served by GitHub Pages
```

### Adding support for a new board
- **CSV:** usually nothing to do. Common names (`t_ms`, `alt`, `pressure`, `ax`, `gps_lat`, `fsm`, …) are recognised by `NAME_RULES` in `src/core.js`. Add a rule there for unusual column names, or just fix them once in the **Columns** dialog.
- **New binary format:** add a `looksLikeX()` / `parseX()` pair next to `parseCATS()` in `src/core.js` that returns `{ columns, rows, events }`, and call it in `addFiles()` in `src/app.js`.

---

## Notes and limitations
- The **Claude assistant** works everywhere. Inside a claude.ai artifact it uses the artifact's built-in Claude access. On GitHub Pages each user pastes their own Anthropic API key (from console.anthropic.com) in the chat panel; the key is stored only in their browser and requests go straight to `api.anthropic.com`, billed to that key.
- The **CSV/PNG download buttons** only work when the page is opened as a claude.ai artifact. On GitHub Pages, “Export summary” copies the CSV to the clipboard instead.
- CATS Vega pyro/action names and the battery scale are decoded from the binary format on a best-effort basis.
- Board temperature sensors measure the electronics bay, not ambient air — set the real ground temperature in the settings row for accurate Mach numbers.
