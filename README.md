# Substack Brand Audit — Champagne Muse Co.

A free lead-magnet tool. Someone pastes their Substack URL and email, and the app:
1. Fetches their homepage, About page, and archive page (plain HTML — no browser needed)
2. Pulls recent post titles and cover images directly from the archive page
3. Sends it all to Gemini (free tier) for a scored brand audit (your Visual Recognition Map™ framework)
4. Returns the full report on the page, ending with a soft pitch to your services

Zero cost to run: no headless browser, no paid API, just Google's Gemini free tier plus free-tier hosting.

## What you need before deploying

1. **A free Gemini API key.** Go to https://aistudio.google.com/apikey, sign in with a Google account, and create a key. No credit card required.
2. **Free hosting.** Since there's no headless browser anymore, this runs fine on **Vercel** or **Netlify** free tiers, or on Render's free web service. Render is the simplest if you want zero config beyond env variables.
3. **(Optional) A Zapier or Make webhook** if you want captured emails to flow automatically somewhere instead of sitting in a file — same as before, since Substack has no public "add subscriber" API.

## Free tier limits to know about (Gemini, Flash model, as of mid-2026)

- **~15 requests per minute** — about 15 people can run an audit in the same minute before the next person needs to wait a few seconds (the server automatically queues and retries, so people should just see a slightly slower response rather than a hard error, up to a point).
- **~1,500 requests per day** — resets at midnight Pacific time. Very unlikely to matter for a newsletter-sized audience, but worth knowing if this ever gets shared somewhere huge.
- Google's free tier terms allow prompts to be used for model training. Worth knowing since this processes other people's Substack content, even though it's low-stakes public info.

## Deploy to Render (recommended — simplest free option)

1. Push this folder to a GitHub repo.
2. In Render: **New → Web Service**, connect the repo, choose the **Free** instance type.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables under **Environment**: `GEMINI_API_KEY` (required), `ZAPIER_WEBHOOK_URL` (optional).
6. Deploy. Render gives you a live `.onrender.com` URL.
7. Note: Render's free tier "sleeps" the service after ~15 minutes of no traffic, so the first visitor after a quiet stretch waits ~30 seconds for it to wake up. Fine for a lead magnet; just don't expect instant loads if nobody's used it recently.

## Running it locally first (recommended before you deploy)

```bash
cd substack-audit-app
npm install
cp .env.example .env
# paste your real GEMINI_API_KEY into .env
npm start
```

Then open `http://localhost:3000` and test it against a few real Substack URLs before it goes live.

## Known limitations to know about

- **Scraping depends on Substack's page structure.** If Substack changes their HTML, the title/cover-image extraction may need a small update. Normal for anything scraping a third-party site.
- **Some publications customize their About/archive setup or lack a public archive.** The server degrades gracefully (skips what it can't find) rather than crashing, but a thinner Substack means a thinner report.
- **Cover images come straight from the archive page**, not a screenshot — this is what makes it free, but it means the visual check is based on the images themselves rather than the full page layout.

## What to test before sharing publicly

- Run it on 3-5 real, varied Substacks to see if the scoring and tone feel right
- Try one with an unusual About/archive setup to check graceful degradation
- Confirm leads are landing where you expect (leads.json or your webhook)
