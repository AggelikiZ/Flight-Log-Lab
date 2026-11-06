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
| **Motor & thrust** | Your motor's numbers, a flight simulation, and the thrust actually delivered, measured from each board, side by side |

Tips: drag on a chart to zoom, double-click to reset. Use **Boost / Ascent / Whole flight / Full log** to change the time range.

### Motor & thrust tab

1. **Load the motor:** click **Load thrust curve…** and pick a `.eng` or `.rse` file (download them from [thrustcurve.org](https://www.thrustcurve.org)) or a `time,thrust` CSV from your static-fire test (units read from the header: `ms`, `kN`, `lbf`, `kgf`; default s and N). No curve file? Use **Enter manually** with total impulse and burn time (the curve is then approximated). Check the **propellant mass** and **total motor mass** below the motor; they are needed for the mass model. Motors are saved in your browser.
2. **Enter the rocket:** wet mass on the pad *including the full motor*, body diameter, drag coefficient (from OpenRocket/RASAero), rail length, launch angle from vertical and pad altitude.
   **Or import it from OpenRocket:** click **Import from OpenRocket (.ork)…** on the Rocket card and pick the simulation that matches your launch (the dialog shows each simulation's motor, apogee, rail and launch site). It fills the rocket values (wet mass, diameter, coast Cd, rail, angle, pad altitude), can add the motor (thrust curve and propellant mass from the simulation), and shows the OpenRocket prediction as its own column and dashed line next to your flight. A switch on the table chooses whether board percentages compare against OpenRocket or the built-in simulation. The simulation must have been saved with its flight data (OpenRocket's default "save simulation data").
3. The tab then shows:
   - **Motor data:** designation and class, total impulse, average and peak thrust, burn time, specific impulse, thrust curve.
   - **Theory vs flight:** a point-mass simulation (rail, drag, propellant burn-off, standard atmosphere) next to every board: impulse, thrust, burnout time/altitude/velocity, max acceleration, max velocity and Mach, rail-exit velocity, apogee.
   - **Thrust measured in flight:** for each board with an accelerometer along the rocket axis, thrust is reconstructed as *T = m·a + ½ρv²·Cd·A*, giving delivered impulse, peak and average thrust and when thrust ended, compared with the nominal curve.
   - **Drag coefficient from the coast:** after burnout the accelerometer only feels drag, so the real Cd is measured; click **Use Cd … in the simulation** to recalibrate.

Limits: the accelerometer cannot see thrust built up on the pad before liftoff (the nominal value for that part is added and shown in the notes); a saturated accelerometer underestimates peak thrust and impulse; the simulation ignores wind and weathercocking. The math lives in `src/motor.js` and is checked by `node test-motor.js`.

### Sharing column profiles with the team

Profiles (column fixes + board names) are saved in your browser only. To share them: **Profiles → Copy JSON**, send it to a teammate, and they paste it in **Profiles → Import**.

---

## Asking Claude about a flight (runs through Claude)

The same app is also published as a **claude.ai artifact**. Opened there, it has a built-in **Flight assistant** chat that runs on your own claude.ai account (Pro/Team plan). No API key and no extra cost: questions count toward your normal claude.ai usage.

**Team link:** https://claude.ai/artifact/JdyFm8sRKWSsWzRjyAWSRq. Ask the team lead to share it with you if it doesn't open.

1. Open the link while signed in to claude.ai.
2. Drop the launch's log files, as on the live site.
3. Click **Ask Claude about this flight** (bottom right). The button appears once a log is loaded.
4. The first time, claude.ai asks you to allow the page to use Claude: click **Allow**.

The assistant reads the computed analysis and can pull exact values from any channel, compute stats over a time window and draw plots right in the chat. Try *"Summarise this flight for our EuRoC report"*, *"Why do the boards disagree on max velocity?"* or *"How did the airbrakes behave?"*.

Notes:
- Use the app's own **Ask Claude about this flight** button, not claude.ai's **Chat** button in the top bar. That one starts a normal Claude conversation that can't see your loaded logs.
- Log files are still processed only in your browser. The assistant receives the analysis summary and the specific values it asks for.
- The chat is not available on the GitHub Pages site. Sites outside claude.ai can't use a Claude subscription.

**Updating the artifact after a code change:** run `node build.js`, then republish `dist/index.html` to the same artifact (e.g. ask Claude Code to "republish dist/index.html to the Flight Log Lab artifact"). The artifact must keep the `sample` (Claude) and `downloads` capabilities turned on.

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
npm install          # one time: downloads the charting library (uPlot)
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
src/openrocket.js   OpenRocket .ork import (design, simulations, flight data)
src/motor.js        Thrust-curve parsers (.eng/.rse/CSV), motor numbers, flight simulation, thrust & Cd extraction
src/app.js          User interface: loading/merging files, charts, tabs, column editor, profiles, export
src/template.html   Page layout and styles
build.js            Bundles everything into one self-contained dist/index.html
test.js             Runs the analysis on log files in a folder and prints the results
test-motor.js       Self-checks for the motor maths (parsers, simulation vs rocket equation, thrust/Cd recovery)
test-openrocket.js  Checks the OpenRocket import on a real file: node test-openrocket.js rocket.ork [motor.eng]
docs/index.html     Published copy served by GitHub Pages
```

### Adding support for a new board
- **CSV:** usually nothing to do. Common names (`t_ms`, `alt`, `pressure`, `ax`, `gps_lat`, `fsm`, …) are recognised by `NAME_RULES` in `src/core.js`. Add a rule there for unusual column names, or just fix them once in the **Columns** dialog.
- **New binary format:** add a `looksLikeX()` / `parseX()` pair next to `parseCATS()` in `src/core.js` that returns `{ columns, rows, events }`, and call it in `addFiles()` in `src/app.js`.

---

## Notes and limitations
- The **Claude assistant** and the **CSV/PNG download buttons** only work when the page is opened as a claude.ai artifact. On GitHub Pages, “Export summary” copies the CSV to the clipboard instead.
- CATS Vega pyro/action names and the battery scale are decoded from the binary format on a best-effort basis.
- Board temperature sensors measure the electronics bay, not ambient air — set the real ground temperature in the settings row for accurate Mach numbers.
