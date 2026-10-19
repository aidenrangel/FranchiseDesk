# Franchise Desk

Your Madden franchise as a stats site. The companion app's **Export** sends your league to a small receiver
(a free Cloudflare Worker), and this site reads it back: standings and playoff seeds, scores and box scores,
team pages with rosters, depth charts and contracts, every player's ratings and game log, season stat tables,
free agents and an opponent-adjusted power index, for every season you export.

```
Companion app ──Export──▶ Cloudflare Worker (stores it) ◀──reads── Franchise Desk (GitHub Pages)
```

## 1. Put the site on GitHub Pages (5 minutes)

1. On GitHub, create a new repository, for example `franchise-desk`.
2. Upload everything in this folder **except the `worker` folder** (index.html, app.js, styles.css, config.js, demo.js, the icons).
3. Repository **Settings → Pages → Branch: main, folder: / (root) → Save**.
4. Your site will be at `https://<your-username>.github.io/franchise-desk/`.

Open it and press **Try the demo league** to look around before the receiver exists.

## 2. Set up the receiver (10 minutes, free, no credit card)

1. Sign up at **dash.cloudflare.com** (free plan).
2. **Workers & Pages → Create → Create Worker.** Name it `franchise-desk`, click **Deploy**, then **Edit code**.
   Delete what's there, paste the contents of `worker/worker.js`, and click **Deploy** again.
3. **Storage & Databases → KV → Create** a namespace (call it `franchise`).
4. Back on the Worker: **Settings → Bindings → Add → KV namespace**.
   Variable name **`LEAGUE`** (exactly), namespace `franchise`. Save.
5. **Settings → Variables and Secrets → Add**: name **`SECRET`**, type Secret, value: a long random word only you know
   (e.g. `dolphins-7f3k9q2`). Save and deploy.
6. Open `https://franchise-desk.<your-subdomain>.workers.dev` in a browser. It should say *Franchise Desk receiver is running.*

## 3. Connect them

- On the site, open **Setup**, paste the Worker address (`https://franchise-desk.<your-subdomain>.workers.dev`),
  press **Test**, then **Save**.
- To make it work on every device without Setup, put the same address in `config.js`:
  `window.FRANCHISE_API = 'https://franchise-desk.<your-subdomain>.workers.dev';` and upload it again.

## 4. Export from the companion app

1. Franchise → **Export**.
2. **Web URL for Export:** `https://franchise-desk.<your-subdomain>.workers.dev/export/<your SECRET>`
3. Pick the week, keep **League Info**, **Rosters** and **Weekly Stats** ticked, tap **Export**.
4. Reload the site. **More → Data received** shows exactly what arrived, piece by piece, with the raw JSON.

The first time, export **all weeks** to backfill the season. After that, export the newest week after each advance.

## Notes

- Anyone with the export URL could overwrite your league, which is why it includes the secret. The read side is public
  (the site needs it), so don't put anything private in your league.
- Free-plan limits are far above what one league uses (Cloudflare allows 1,000 KV writes and 100,000 reads a day; one
  week's export is about 45 writes).
- Data is cached in your browser, so after the first load the site only asks the receiver whether anything changed.
- Weekly stats are kept per season, so you can switch seasons in the gear menu once you've played more than one.
- Totals are the sum of the weeks you exported; a skipped week is missing from them until you export it.
- If EA changes the export format, the Data received page shows what came in so the site can be adjusted.
