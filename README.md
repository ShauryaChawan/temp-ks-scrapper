# Swiggy Ads Performance Scraper

A Puppeteer-based Node.js script that opens the Swiggy Partner Ads Performance dashboard, selects an outlet and reporting dates, reads the embedded Power BI metrics, and exports the result as JSON.

## Workflow

1. Launch Chrome in visible mode with a persistent `chrome-profile` directory.
2. Open the Swiggy Partner Ads Performance page for the configured Swiggy restaurant ID (`res_id`).
3. Pause for manual login and dashboard readiness; press Enter in the terminal to continue.
4. Open the **Outlet name & RID** filter.
5. Deselect the outlets that are already selected.
6. Search for and select the target Swiggy outlet using its RID.
7. Confirm the outlet selection.
8. Calculate yesterday's date and set both the **To** and **From** date filters to that date.
9. Find the embedded Power BI report using its report ID.
10. Poll the report for all nine required metrics:
    - Ad Spends
    - Impressions
    - Menu Visits
    - Orders
    - NU Orders
    - Sales
    - AOV
    - CPC
    - ROAS
11. Poll every 2 seconds for the first 30 seconds. If the metrics are not ready, continue polling every 5 seconds until 2 minutes total.
12. If the metrics still are not available, print diagnostic details and keep Chrome open so the report can be inspected manually.
13. When all metrics are found, normalize metric labels to lowercase `snake_case` keys and parse their displayed values into numbers.
14. Build the JSON response with report dates, extraction timestamp, extraction duration, Swiggy restaurant ID, internal outlet ID, and metrics.
15. Print the JSON and save it to a timestamped `.json` file in the current working directory.
16. Keep Chrome open after completion for inspection. Press `Ctrl+C` in the terminal when you want to stop the process.

## Requirements

- Node.js
- Puppeteer
- Access to the Swiggy Partner dashboard and a valid login session

Install Puppeteer if it is not already installed:

```bash
npm install puppeteer
```

## Run

The script accepts IDs as command-line arguments:

```bash
node scrape.js --res-id=10979 --target-rid=26584 --outlet-id=YOUR_INTERNAL_OUTLET_ID
```

Arguments:

| Argument | Meaning | Default |
|---|---|---|
| `--res-id` | Swiggy restaurant ID used in the dashboard URL and emitted as `report_metadata.res_id` | `10979` |
| `--target-rid` | Swiggy outlet RID selected in the dashboard | `26584` |
| `--outlet-id` | Your system's internal outlet ID emitted as `report_metadata.outlet_id` | `null` |

Replace `YOUR_INTERNAL_OUTLET_ID` with the outlet ID supplied by your system. The Swiggy RID and your internal outlet ID are separate identifiers.

On the first run, log in to Swiggy in the opened Chrome window if prompted. Wait until the Ads Performance dashboard is ready, then return to the terminal and press Enter. The profile is stored in `./chrome-profile` so the session can persist between runs.

## JSON output

The output uses flat key-value pairs for metrics, as requested:

```json
{
  "report_metadata": {
    "platform": "swiggy",
    "report_name": "ads_performance",
    "from_date": "2026-10-22",
    "to_date": "2026-10-22",
    "extracted_at": "2026-10-23T11:00:00+05:30",
    "extraction_duration_ms": 12500,
    "res_id": "10979",
    "outlet_id": "YOUR_INTERNAL_OUTLET_ID"
  },
  "metrics": {
    "ad_spends": 307,
    "impressions": 892,
    "menu_visits": 49,
    "orders": 4,
    "nu_orders": 3,
    "sales": 4109,
    "aov": 1027,
    "cpc": 6.3,
    "roas": 13.37
  }
}
```

The values above are examples only. The script generates dates, timestamp, duration, IDs, and metric values at runtime.

- `from_date` and `to_date` use `YYYY-MM-DD`.
- `extracted_at` is formatted with the configured `Asia/Kolkata` offset.
- `extraction_duration_ms` measures elapsed time from pressing Enter after dashboard readiness through successful metric extraction and JSON creation.
- Metric values are numeric; currency symbols and thousands separators are removed.
- The JSON does not include per-metric unit objects, `currency`, or `timezone`, following the agreed output schema.

## Output file

The script writes a timestamped file such as:

```text
swiggy_ads_performance_26584_2026-10-22_2026-10-23T11-00-00-05-30.json
```

The file is saved to the current working directory from which `node scrape.js` is run.

## Troubleshooting

- **Login/session issue:** Complete login in the visible Chrome window and retry.
- **Metrics not found:** After 30 seconds the polling interval changes from 2 seconds to 5 seconds; the total wait ends at 2 minutes. The terminal prints the last Power BI diagnostic information, and Chrome stays open for inspection.
- **Process remains running:** This is intentional so Chrome stays open after success or failure. Press `Ctrl+C` in the terminal when you are done inspecting.
- **IDs:** Verify that `--res-id`, `--target-rid`, and `--outlet-id` correspond to the correct identifiers. `--outlet-id` is your internal system ID; it is not used to select the Swiggy outlet.
