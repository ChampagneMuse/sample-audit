require('dotenv').config();
const express = require('express');
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-flash-latest'; // auto-points to Google's current recommended Flash model
const GEMINI_FALLBACK_MODEL = 'gemini-3.6-flash'; // stable, less likely to be overloaded than the latest/preview alias
const ZAPIER_WEBHOOK_URL = process.env.ZAPIER_WEBHOOK_URL || null;
const LEADS_FILE = path.join(__dirname, 'leads.json');

const SYSTEM_PROMPT = `You are the Champagne Muse Substack Audit engine. You write in a warm, dry, self-aware, ironic, personal voice — never salesy, never corporate, never exclamation-heavy. No em dashes anywhere. Parenthetical humor and deliberate imperfection over polished genericness.

Analyze the provided Substack text and cover images through this framework:

SECTIONS TO ASSESS (score each /10):
1. Brand clarity - is positioning obvious fast
2. Visual cohesion - do covers/palette/fonts/layout feel like one system
3. Voice consistency - does tone hold across About, titles
4. Messaging strength - clear value prop, not vague
5. Homepage effectiveness - headline, meta description, first impression
6. About page strength - trust, tone-setting, clear "who this is for"
7. Post title quality - human not AI-sounding, not salesy, knowledgeable + personal mix
8. Content consistency - topics support one positioning, not scattered
9. Conversion readiness - clear next step for a new reader

Weight toward business impact: conversion readiness and clarity matter as much as aesthetics.

OUTPUT FORMAT (return ONLY valid JSON, no markdown fences, no preamble, no code block):
{
  "brand_snapshot": "3-5 line overview: publication name, positioning, niche, first impression, brand temperature (polished/personal/premium/minimal/experimental)",
  "overall_score": <weighted average out of 10, one decimal>,
  "scores": [
    {"category": "Brand clarity", "score": <n>, "working": "1 short sentence", "weakening": "1 short sentence", "fix": "1 sentence priority fix"}
  ],
  "visual_check": "Specific read on whether post covers share one palette/font/texture/layout system, or feel disconnected. If no cover images were provided, say so plainly.",
  "title_check": "Specific read on whether titles sound human vs AI-generated vs too salesy, with the knowledgeable/personal balance called out.",
  "priority_fixes": {
    "urgent": ["1-2 items affecting trust/conversion now"],
    "important": ["1-2 items affecting clarity/consistency"],
    "optional": ["1 nice-to-have"]
  }
}`;

function normalizeUrl(input) {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/$/, '');
}

async function safeFetchText(url) {
  try {
    const res = await fetch(url, { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SubstackAuditBot/1.0)' } });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  }
}

async function imageUrlToBase64(url) {
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) return null;
    const buf = await res.buffer();
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    return { data: buf.toString('base64'), mimeType };
  } catch (e) {
    return null;
  }
}

async function scrapeSubstack(baseUrl) {
  const result = { pubName: null, metaDescription: null, aboutText: null, titles: [], coverImageUrls: [] };

  // Homepage
  const homeHtml = await safeFetchText(baseUrl);
  if (homeHtml) {
    const $ = cheerio.load(homeHtml);
    result.pubName = $('meta[property="og:title"]').attr('content') || $('title').first().text().trim() || null;
    result.metaDescription = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || null;
  }

  // About page
  const aboutHtml = await safeFetchText(baseUrl + '/about');
  if (aboutHtml) {
    const $ = cheerio.load(aboutHtml);
    $('script, style, nav, header, footer').remove();
    const text = $('body').text().replace(/\s+/g, ' ').trim();
    result.aboutText = text.slice(0, 3000);
  }

  // Archive page — titles + cover images (Substack renders post cards with <img> covers directly)
  const archiveHtml = await safeFetchText(baseUrl + '/archive');
  if (archiveHtml) {
    const $ = cheerio.load(archiveHtml);
    $('a').each((i, el) => {
      const t = $(el).text().trim();
      if (t && t.length > 8 && t.length < 140 && result.titles.length < 12) {
        result.titles.push(t);
      }
    });
    result.titles = [...new Set(result.titles)].slice(0, 10);

    $('img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && src.startsWith('http') && result.coverImageUrls.length < 6) {
        result.coverImageUrls.push(src);
      }
    });
    result.coverImageUrls = [...new Set(result.coverImageUrls)].slice(0, 6);
  }

  return result;
}

// --- Simple rate-limited queue to stay under Gemini's free-tier RPM ---
const QUEUE = [];
let processing = false;
const MIN_GAP_MS = 4200; // ~14 requests/minute, just under the ~15 RPM free-tier cap

function enqueue(task) {
  return new Promise((resolve, reject) => {
    QUEUE.push({ task, resolve, reject });
    processQueue();
  });
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (QUEUE.length) {
    const { task, resolve, reject } = QUEUE.shift();
    try {
      const result = await runWithRetry(task);
      resolve(result);
    } catch (err) {
      reject(err);
    }
    await new Promise(r => setTimeout(r, MIN_GAP_MS));
  }
  processing = false;
}

const RETRYABLE_STATUSES = new Set([429, 500, 503]);
const MAX_RETRY_ATTEMPTS = 5;

async function runWithRetry(task, attempt = 1) {
  try {
    return await task();
  } catch (err) {
    const retryable = RETRYABLE_STATUSES.has(err.status);
    if (retryable && attempt <= MAX_RETRY_ATTEMPTS) {
      // Exponential backoff with jitter: 1.5s, 3s, 6s, 12s, 24s (+/- randomness)
      const base = 1500 * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 500;
      const backoff = base + jitter;
      console.log(`Gemini ${err.status} on attempt ${attempt}, retrying in ${Math.round(backoff)}ms...`);
      await new Promise(r => setTimeout(r, backoff));
      return runWithRetry(task, attempt + 1);
    }
    throw err;
  }
}

async function callGemini(scraped, url) {
  const parts = [
    {
      text: `Substack URL: ${url}\nPublication title: ${scraped.pubName || '(unknown)'}\nHomepage meta description: ${scraped.metaDescription || '(none)'}\n\nAbout page text:\n${scraped.aboutText || '(not found)'}\n\nRecent post titles:\n${scraped.titles.join('\n') || '(none found)'}\n\n${scraped.coverImageUrls.length ? 'Post cover images follow.' : 'No cover images could be retrieved.'}`
    }
  ];

  for (const imgUrl of scraped.coverImageUrls) {
    const img = await imageUrlToBase64(imgUrl);
    if (img) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
  }

  const callModel = async (model) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { responseMimeType: 'application/json' }
        })
      }
    );
    if (RETRYABLE_STATUSES.has(res.status)) {
      const err = new Error(`Gemini returned ${res.status} for model ${model}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (!res.ok) throw new Error('Gemini API error: ' + JSON.stringify(data));
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('No content returned from Gemini');
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  };

  const task = async () => {
    try {
      return await callModel(GEMINI_MODEL);
    } catch (err) {
      // Primary model exhausted its retries (runWithRetry already retried this
      // task 5x before giving up) — try once on the fallback model before failing.
      if (RETRYABLE_STATUSES.has(err.status) && GEMINI_FALLBACK_MODEL) {
        console.log(`Primary model failed after retries (${err.status}), trying fallback model ${GEMINI_FALLBACK_MODEL}...`);
        return await callModel(GEMINI_FALLBACK_MODEL);
      }
      throw err;
    }
  };

  return enqueue(task);
}

function saveLead(email, url) {
  const lead = { email, url, submittedAt: new Date().toISOString() };
  try {
    const existing = fs.existsSync(LEADS_FILE) ? JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')) : [];
    existing.push(lead);
    fs.writeFileSync(LEADS_FILE, JSON.stringify(existing, null, 2));
  } catch (e) {
    console.error('Could not write leads.json', e);
  }
  if (ZAPIER_WEBHOOK_URL) {
    fetch(ZAPIER_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead)
    }).catch(err => console.error('Zapier webhook failed', err));
  }
}

app.post('/api/audit', async (req, res) => {
  try {
    const { url, email } = req.body;
    if (!url || !email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid Substack URL and email are required.' });
    }
    const baseUrl = normalizeUrl(url);

    saveLead(email, baseUrl);

    const scraped = await scrapeSubstack(baseUrl);
    if (!scraped.pubName && !scraped.aboutText && scraped.titles.length === 0) {
      return res.status(422).json({ error: "Couldn't reach that Substack. Double-check the URL and try again." });
    }

    const report = await callGemini(scraped, baseUrl);
    res.json(report);
  } catch (err) {
    console.error(err);
    if (err.status === 429) {
      return res.status(429).json({ error: "We're getting a lot of audits right now — try again in a minute." });
    }
    if (err.status === 503 || err.status === 500) {
      return res.status(503).json({ error: "Gemini is overloaded on their end right now, even after retrying twice on two models. Give it a few minutes and try again." });
    }
    res.status(500).json({ error: 'Something went wrong generating the audit. Try again shortly.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Substack audit server (Gemini free tier) running on port ${PORT}`));
