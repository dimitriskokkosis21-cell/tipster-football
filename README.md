# TIPSTER — Football Intelligence

TIPSTER is a Node.js football analytics web application for mobile Safari and desktop browsers.

## What works
- Server-side football fixtures and recent completed results via public JSON interfaces: ESPN (unofficial), OpenLigaDB for Bundesliga, and a limited TheSportsDB fallback.
- Today, Tomorrow, and Next 7 days in Europe/Athens, league filtering, independent match details, refresh, data coverage diagnostics.
- Data-driven time-weighted home/away goal rates, shrinkage toward competition priors, Poisson goal distributions with Dixon–Coles correction.
- 1/X/2 probabilities normalized to 100%, fair decimal odds, five exact scores, O/U 2.5, BTTS.
- NO VERIFIED PRICE for matches without sourced bookmaker odds; conservative minimum betting prices required for a value bet.
- Clear absence labels when xG, lineups, injuries, bookmaker prices or enough recent results are not provided.

## Current limitations
- ESPN's football JSON endpoints are unofficial and might not be available or authorized for commercial production use. Check provider terms. TheSportsDB free access is heavily limited and cannot guarantee all seven-day fixtures. No current bookmaker integration, so the dashboard **does not issue actual qualifying value-bet picks**.
- Historical scoring model is preliminary, **not proven calibrated**; no profitability claims. When recent histories are unavailable, estimates are conservatively shrunk to generic league scoring priors and marked low quality. This is not real-money betting advice.
- This version does not include persistent prediction history or injury/starting-lineup/xG provider integrations.
- Some provider ranges may be truncated or missing despite HTTP success. Monitor the Data Sources section.

## Local run

Requires Node.js 20 or newer; no dependencies and no API keys.

```sh
npm start
```

Visit http://localhost:3000/ and http://localhost:3000/api/health.

## Render deployment

The root-level `render.yaml` configures a free Node web service in Frankfurt, running `node server.mjs` with HTTP health checks at `/api/health`. Repository:
https://github.com/dimitriskokkosis21-cell/tipster-football

The connected Render account returned **HTTP 402 Payment information is required** when service creation was attempted. Account owner must add a payment method in Render billing before deployment can proceed. Choosing the free plan does not override account billing eligibility.

Recommended manual alternative: in https://dashboard.render.com select **New > Web Service**, connect the GitHub repository, use `Node`, `node --version` as the build command and `node server.mjs` as the start command. Set health check to `/api/health`. Do not interpret a successful build alone as confirmation that the football providers work.

## Production checks

1. Ensure `/api/health` returns 200 with `ok:true`.
2. Ensure `/api/matches` returns verified upcoming fixtures (or an honest error / empty result), valid probabilities totaling 1, and reciprocal fair odds.
3. Verify data-source coverage warnings in the browser; test on iPhone Safari.
4. Periodically review upstream provider access and complete an out-of-sample calibration evaluation before trusting quantitative edges.

No fabricated bookmaker quotes or injuries are included.
