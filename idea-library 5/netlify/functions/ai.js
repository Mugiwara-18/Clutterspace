// Free Netlify Function: asks Gemini to write a clean title, pick a collection and suggest tags.
// Needs one environment variable in Netlify: GEMINI_API_KEY (free key from https://aistudio.google.com/apikey)
// Optional: GEMINI_MODEL to override the model.
const MODELS = [
  ...new Set(
    [
      process.env.GEMINI_MODEL,
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-2.0-flash",
    ].filter(Boolean)
  ),
];

const json = (code, body) => ({
  statusCode: code,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function cleanInputPiece(s) {
  if (!s) return "";
  let t = String(s).trim();
  if (!t) return "";
  if (/^(instagram|youtube|tiktok|untitled idea|saved link|login\s*[•·-]\s*instagram|log in\s*[•·-]\s*instagram)$/i.test(t)) return "";
  if (/^(instagram|youtube|x|linkedin|reddit|github|tiktok|link)\s+(reel|post|video|short|link)(\s*[·•-]\s*[\w-]+)?$/i.test(t)) return "";
  if (/create an account or log in to instagram/i.test(t)) return "";
  t = t.replace(/^[\d,.]+[KMBkmb]?\s+likes?,\s*[\d,.]+[KMBkmb]?\s+comments?\s*[-–—]\s*[^:：]+?\s+on\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}\s*[:：]\s*/i, "");
  t = t.replace(/^[^:：\n]{1,70}\s+on\s+Instagram\s*[:：]\s*/i, "");
  const q = t.match(/^["“']([\s\S]+?)["”']\.?\s*$/);
  if (q) t = q[1].trim();
  return t.trim();
}

function extractJson(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const nonThought = parts
    .filter((p) => !p.thought && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
  const raw = nonThought || parts.map((p) => p.text || "").join("\n").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    try {
      return JSON.parse(cleaned);
    } catch (e2) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      return null;
    }
  }
}

async function callGemini(model, key, prompt, timeoutMs = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.15,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              collection: { type: "STRING" },
              tags: { type: "ARRAY", items: { type: "STRING" } },
              summary: { type: "STRING" },
            },
            required: ["title", "collection", "tags", "summary"],
          },
        },
      }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      let errText = "";
      try { errText = (await res.text()).slice(0, 200); } catch (e) {}
      return { status: res.status, error: errText };
    }
    const data = await res.json();
    const out = extractJson(data);
    if (!out) return { status: 500, error: "invalid json output" };
    return { status: 200, out };
  } catch (e) {
    return { status: 0, error: e && e.name === "AbortError" ? "timeout" : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async (event) => {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) return json(200, { error: "no key" });
  let b = {};
  try {
    b = JSON.parse(event.body || "{}");
  } catch (e) {
    return json(400, { error: "bad body" });
  }

  const collections = (Array.isArray(b.collections) ? b.collections : [])
    .filter((c) => c && c !== "Inbox")
    .slice(0, 30);

  const pieces = [
    cleanInputPiece(b.title),
    cleanInputPiece(b.description),
    cleanInputPiece(b.note),
    b.author ? `Creator: ${b.author}` : "",
  ].filter(Boolean);
  // Deduplicate identical title/description
  const uniquePieces = [...new Set(pieces)];
  const text = uniquePieces.join("\n").slice(0, 2800);
  if (!text.trim()) return json(200, { error: "no text" });

  const prompt = `You organise a person's saved Instagram reels, YouTube shorts and links into a personal digital library.
Given the scraped caption, note and creator info for ONE saved link, return JSON with:
1. "title": A clear, specific, human-readable title of what the content is about (max 70 chars, sentence case).
   - Capture the core idea, tool, tutorial topic, resource list, or recommendation.
   - If it recommends specific books, movies, anime, websites, or tools, include their names.
   - If the caption is mostly hashtags or short text, infer a clean descriptive title from the hashtags/topic and creator.
   - NEVER output generic phrases like "Instagram reel", "Instagram post", "Untitled", @usernames, emojis, or #hashtags.
2. "collection": Pick the SINGLE best match from ${JSON.stringify(collections)}, or "Inbox" ONLY if none of the categories fit at all.
   Category guide:
   - "Content ideas": hooks, viral formats, storytelling, video editing (CapCut, Premiere, DaVinci), camera/lighting tips, scriptwriting, creator growth, social media strategy.
   - "UI/UX": UI/UX design, Figma, websites/tools for designers, portfolios, typography, fonts, color palettes, landing pages, Framer, Webflow, micro-interactions, branding, design inspiration.
   - "Development": coding, programming, software engineering, web/app dev, JavaScript/TypeScript/React/Python/CSS, AI tools, LLMs, prompts, AI agents, GitHub repos, APIs, developer tools, tech tutorials.
   - "Books": book recommendations, reading lists, book summaries, authors, non-fiction, fiction, self-improvement books.
   - "Anime": anime series/films, manga, manhwa, anime edits, character breakdowns, watchlists (Naruto, One Piece, JJK, AOT, etc.).
   - "Movies": movies, TV shows, web series, cinema, trailers, film recommendations, cinematography breakdowns.
   - "Jobs": job openings, hiring alerts, referrals, internships, resume/CV tips, interview prep, career advice, remote job boards, tech salaries.
   (If the user has additional custom collections in the list above, match those by their name.)
3. "tags": 2 to 5 short lowercase tags (single words or two-word phrases), no # sign.
4. "summary": One concise plain sentence (max 140 chars) explaining what this save is and why it's useful.

Link: ${b.url || ""}
Scraped content:
"""
${text}
"""`;

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let lastErr = "gemini failed";

  for (const model of MODELS) {
    const r = await callGemini(model, key, prompt, 5500);
    if (r.status === 200 && r.out) {
      const o = r.out;
      const matchedCol = collections.find((c) => norm(c) === norm(o.collection)) || "Inbox";
      return json(200, {
        title: cleanInputPiece(o.title).slice(0, 90),
        collection: matchedCol,
        tags: (Array.isArray(o.tags) ? o.tags : [])
          .map((t) => String(t).toLowerCase().replace(/^#/, "").trim())
          .filter(Boolean)
          .slice(0, 5),
        summary: String(o.summary || "").trim().slice(0, 200),
        model,
      });
    }
    lastErr = `${model}: status ${r.status} ${r.error || ""}`.trim();
    if (r.status === 429) return json(200, { error: "rate limited", detail: lastErr });
    // If timeout (status 0), try at most one more fast model so we stay within Netlify's 10s limit
    if (r.status === 0) break;
  }
  return json(200, { error: "gemini failed", detail: lastErr });
};
