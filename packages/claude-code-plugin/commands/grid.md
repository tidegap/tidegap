---
description: Show current and 24-hour carbon intensity for a grid region
---

Show current grid carbon intensity plus the next 24-hour forecast so the user
can decide whether to run a workload now or wait.

## Arguments

`$ARGUMENTS`

- Electricity Maps zone code. Common values: `US-CAL-CISO`, `US-TEX-ERCO`,
  `US-NE-ISNE`, `US-MIDA-PJM`, `GB`, `FR`, `DE`.
- `get_grid_forecast` requires an explicit `region`. If the user gives none,
  run `tidegap region show --json` and use its `effective` zone: the region
  every Tidegap surface on this machine uses (flag, `TIDEGAP_DEFAULT_REGION`,
  the stored setting, the time-zone guess, else `GB`). If the `tidegap` CLI
  is not installed, use `GB`. Tell the user which zone you used and that
  `tidegap region set <zone>` changes it.
- The zone must be a supported one (`tidegap region list`). An unknown zone
  fails with the closest matches (`Unknown zone UA. Closest: PL. …`): offer
  them, and do not retry with a guess.
- If the user gives a country name (e.g. "France"), translate to the zone code
  before calling the tool. Do not pass free-form names to the MCP server.

## What to do

1. Call the `tidegap` MCP server's **`get_grid_forecast`** tool with:
   - `region` — the parsed zone code
   - `hours` — 24
2. The tool returns a **plain-text report**, not JSON. Its shape:

   ```
   Region: <zone>
   Source: <source>
   Generated: <iso timestamp>

   Hour | gCO2/kWh | band
   ---  | ---      | ---
   HH:MM |  <n> | <band>
   ... one row per hour ...

   Cleanest hour: <iso> (<n> gCO2/kWh, <band>)
   Dirtiest hour: <iso> (<n> gCO2/kWh, <band>)
   ```

   From it, compute:
   - **Now** — the first table row (intensity + band)
   - **Cleanest / dirtiest hour** — read the summary lines verbatim,
     converted to a time-from-now offset
   - **Average over 24h** — mean of the table rows
3. Render as:

   ```
   <zone> · <data source>
     now         <intensity> g/kWh  (<band>)
     cleanest    <intensity> g/kWh  (in <Xh>, <band>)
     dirtiest    <intensity> g/kWh  (in <Xh>, <band>)
     average     <intensity> g/kWh
   ```

   `<data source>` is the `Source:` line — one of `electricityMaps` /
   `ukCarbonIntensity` / `eia` / `entsoe` / `mock`. Be honest with the
   user: `mock` means synthetic data (no live feed for the zone), so
   present the numbers as an illustrative baseline, not a measurement.
4. End with a one-line recommendation:
   - If `now` is in `clean` or `very_clean` band: "Run now — grid is already
     clean."
   - If `cleanest_hour < now * 0.7`: "Defer if you can — <X>% cleaner in <Yh>."
   - Otherwise: "No meaningful intraday variation — run when convenient."

## Examples

```
/tidegap:grid
/tidegap:grid GB
/tidegap:grid US-TEX-ERCO
```
