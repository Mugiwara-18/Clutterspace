// Free Netlify Function: fetches a public page and returns its title / description / image / author.
// Uses multiple strategies for Instagram reels/posts (crawler OG tags, /embed/captioned/, and Microlink fallback)
// as well as YouTube/TikTok oEmbed so cloud IPs don't get stuck on login walls.

const CRAWLER_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function decode(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(html) {
  return decode(
    String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function meta(html, names) {
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, "i");
    const m = html.match(re1) || html.match(re2);
    if (m && m[1]) return decode(m[1]);
  }
  return "";
}

function isJunkText(s) {
  if (!s) return true;
  const t = String(s).trim();
  if (!t) return true;
  if (/^(instagram|youtube|tiktok|login\s*[•·-]\s*instagram|log in\s*[•·-]\s*instagram)$/i.test(t)) return true;
  if (/create an account or log in to instagram/i.test(t)) return true;
  if (/see instagram photos and videos from/i.test(t) && !/[:：]/.test(t)) return true;
  return false;
}

function cleanInstagramText(s) {
  if (!s || isJunkText(s)) return "";
  let t = String(s).trim();
  // Strip leading "12K likes, 45 comments - username on Month Day, Year: "
  t = t.replace(/^[\d,.]+[KMBkmb]?\s+likes?,\s*[\d,.]+[KMBkmb]?\s+comments?\s*[-–—]\s*[^:：]+?\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s*[:：]\s*/i, "");
  // Strip leading "Name (@user) on Instagram: " or "Name on Instagram: "
  t = t.replace(/^[^:：\n]{1,70}\s+on\s+Instagram\s*[:：]\s*/i, "");
  // Strip wrapping quotes (including trailing dot after quote)
  const q = t.match(/^["“']([\s\S]+?)["”']\.?\s*$/);
  if (q) t = q[1].trim();
  if (isJunkText(t)) return "";
  // If only likes/comments count with no caption
  if (/^[\d,.]+[KMBkmb]?\s+likes?,\s*[\d,.]+[KMBkmb]?\s+comments?\s*[-–—]/i.test(t) && !/[:：]/.test(t)) return "";
  return t.trim();
}

function unescapeJsonStr(s) {
  try {
    return JSON.parse(`"${s.replace(/"/g, '\\"')}"`);
  } catch (e) {
    try {
      return JSON.parse(`"${s}"`);
    } catch (e2) {
      return decode(s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\//g, "/"));
    }
  }
}

async function fetchWithTimeout(url, headers, ms = 4500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { headers, redirect: "follow", signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeInstagramEmbed(code) {
  const out = { title: "", description: "", image: "", author: "" };
  try {
    const url = `https://www.instagram.com/p/${code}/embed/captioned/`;
    const res = await fetchWithTimeout(url, {
      "user-agent": BROWSER_UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    }, 4500);
    if (!res.ok) return out;
    const html = (await res.text()).slice(0, 600000);

    // 1. Extract image from EmbeddedMediaImage or JSON display_url
    const imgMatch =
      html.match(/class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/i) ||
      html.match(/src=["']([^"']+)["'][^>]+class=["'][^"']*EmbeddedMediaImage/i);
    if (imgMatch && imgMatch[1]) {
      out.image = decode(imgMatch[1]);
    } else {
      const dispMatch = html.match(/\\?"display_url\\?"\s*:\s*\\?"([^"\\]+(?:\\.[^"\\]*)*)\\?"/);
      if (dispMatch && dispMatch[1]) out.image = unescapeJsonStr(dispMatch[1]);
    }

    // 2. Extract author username
    const userMatch =
      html.match(/class=["'][^"']*UsernameText[^"']*["'][^>]*>([^<]+)</i) ||
      html.match(/class=["'][^"']*CaptionUsername[^"']*["'][^>]*>([^<]+)</i);
    if (userMatch && userMatch[1]) out.author = decode(userMatch[1]);

    // 3. Extract caption from <div class="Caption">
    const capBlock = html.match(/<div[^>]+class=["'][^"']*Caption["'][^>]*>([\s\S]*?)<\/div>/i);
    if (capBlock && capBlock[1]) {
      let c = capBlock[1]
        .replace(/<a[^>]+class=["'][^"']*CaptionUsername[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, "")
        .replace(/<div[^>]+class=["'][^"']*CaptionComments[^"']*["'][^>]*>[\s\S]*$/gi, "");
      c = stripTags(c);
      if (c && !isJunkText(c)) out.description = c;
    }

    // 4. Fallback: check embedded JSON for edge_media_to_caption
    if (!out.description) {
      const jsonCap =
        html.match(/\\?"edge_media_to_caption\\?"\s*:\s*\{\s*\\?"edges\\?"\s*:\s*\[\s*\{\s*\\?"node\\?"\s*:\s*\{\s*\\?"text\\?"\s*:\s*\\?"((?:\\.|[^"\\])*)\\?"/) ||
        html.match(/\\?"caption\\?"\s*:\s*\\?"((?:\\.|[^"\\]){5,})\\?"/);
      if (jsonCap && jsonCap[1]) {
        const parsed = unescapeJsonStr(jsonCap[1]).trim();
        if (!isJunkText(parsed)) out.description = parsed;
      }
    }

    if (out.description) {
      out.title = out.description.split(/\n/)[0].slice(0, 120);
    }
  } catch (e) {}
  return out;
}

async function scrapeMicrolink(targetUrl) {
  const out = { title: "", description: "", image: "", author: "" };
  try {
    const api = `https://api.microlink.io/?url=${encodeURIComponent(targetUrl)}`;
    const res = await fetchWithTimeout(api, { accept: "application/json" }, 4000);
    if (!res.ok) return out;
    const j = await res.json();
    const d = j && j.data ? j.data : {};
    if (d.title && !isJunkText(d.title)) out.title = cleanInstagramText(d.title) || d.title;
    if (d.description && !isJunkText(d.description)) out.description = cleanInstagramText(d.description) || d.description;
    if (d.image && d.image.url) out.image = d.image.url;
    if (d.author) out.author = d.author;
  } catch (e) {}
  return out;
}

async function scrapeOEmbed(u) {
  const out = { title: "", description: "", image: "", author: "" };
  try {
    let ep = "";
    if (/youtu\.?be|youtube\.com/i.test(u.hostname)) {
      ep = `https://www.youtube.com/oembed?url=${encodeURIComponent(u.toString())}&format=json`;
    } else if (/tiktok\.com/i.test(u.hostname)) {
      ep = `https://www.tiktok.com/oembed?url=${encodeURIComponent(u.toString())}`;
    }
    if (!ep) return out;
    const res = await fetchWithTimeout(ep, { accept: "application/json" }, 3500);
    if (!res.ok) return out;
    const j = await res.json();
    if (j.title) out.title = j.title;
    if (j.author_name) out.author = j.author_name;
    if (j.thumbnail_url) out.image = j.thumbnail_url;
  } catch (e) {}
  return out;
}

function blockedHost(host) {
  if (!host.includes(".")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  return false;
}

const json = (code, body) => ({
  statusCode: code,
  headers: { "content-type": "application/json", "cache-control": "public, max-age=1800" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  const raw = (event.queryStringParameters || {}).url || "";
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return json(400, { error: "bad url" });
  }
  if (!/^https?:$/.test(u.protocol) || blockedHost(u.hostname)) return json(400, { error: "url not allowed" });

  const isIg = /instagram\.com$/i.test(u.hostname);
  const igCodeMatch = isIg ? u.pathname.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i) : null;
  const igCode = igCodeMatch ? igCodeMatch[1] : "";

  let title = "";
  let description = "";
  let image = "";
  let site = "";
  let author = "";

  // 1. If Instagram with shortcode, run crawler OG fetch + embed/captioned fetch in parallel for speed & reliability
  if (isIg && igCode) {
    const [ogRes, emb] = await Promise.all([
      (async () => {
        try {
          const res = await fetchWithTimeout(u.toString(), {
            "user-agent": CRAWLER_UA,
            accept: "text/html,*/*",
            "accept-language": "en-US,en;q=0.9",
          }, 4500);
          const html = (await res.text()).slice(0, 500000);
          const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
          const rawT = meta(html, ["og:title", "twitter:title"]) || decode(titleTag);
          const rawD = meta(html, ["og:description", "twitter:description", "description"]);
          const authorMatch = rawT.match(/^(.+?)\s+on\s+Instagram/i) || rawD.match(/[-–—]\s*([^:：\n]+?)\s+on\s+[A-Za-z]+\s+\d/i);
          return {
            title: cleanInstagramText(rawT),
            description: cleanInstagramText(rawD),
            image: meta(html, ["og:image", "twitter:image"]),
            site: "Instagram",
            author: authorMatch ? authorMatch[1].trim() : "",
          };
        } catch (e) {
          return {};
        }
      })(),
      scrapeInstagramEmbed(igCode),
    ]);

    title = ogRes.title || emb.title || "";
    description = emb.description || ogRes.description || "";
    image = ogRes.image || emb.image || "";
    author = emb.author || ogRes.author || "";
    site = "Instagram";

    // If both direct fetches were blocked by Instagram, try Microlink as backup
    if (!title && !description && !image) {
      const ml = await scrapeMicrolink(u.toString());
      title = ml.title || title;
      description = ml.description || description;
      image = ml.image || image;
      author = ml.author || author;
    }
  } else {
    // 2. Non-Instagram URLs: run direct HTML scrape + oEmbed in parallel
    const [htmlRes, oemb] = await Promise.all([
      (async () => {
        try {
          const res = await fetchWithTimeout(u.toString(), {
            "user-agent": CRAWLER_UA,
            accept: "text/html,*/*",
            "accept-language": "en",
          }, 5000);
          const html = (await res.text()).slice(0, 500000);
          const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
          return {
            title: meta(html, ["og:title", "twitter:title"]) || decode(titleTag),
            description: meta(html, ["og:description", "twitter:description", "description"]),
            image: meta(html, ["og:image", "twitter:image"]),
            site: meta(html, ["og:site_name"]),
          };
        } catch (e) {
          return {};
        }
      })(),
      scrapeOEmbed(u),
    ]);

    title = (!isJunkText(htmlRes.title) ? htmlRes.title : "") || oemb.title || "";
    description = (!isJunkText(htmlRes.description) ? htmlRes.description : "") || oemb.description || "";
    image = htmlRes.image || oemb.image || "";
    author = oemb.author || "";
    site = htmlRes.site || "";
  }

  if (!title && !description && !image) {
    return json(200, { error: "no metadata" });
  }
  return json(200, { title, description, image, site, author });
};
