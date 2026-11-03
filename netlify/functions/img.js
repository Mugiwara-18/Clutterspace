// Free Netlify Function: fetches a thumbnail image server-side (Instagram blocks hot-linking from other sites)
// and hands it back to the app, which stores a permanent copy.
function blockedHost(host) {
  if (!host.includes(".")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  return false;
}
exports.handler = async (event) => {
  let u;
  try { u = new URL((event.queryStringParameters || {}).url || ""); } catch (e) { return { statusCode: 400, body: "bad url" }; }
  if (!/^https?:$/.test(u.protocol) || blockedHost(u.hostname)) return { statusCode: 400, body: "not allowed" };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const res = await fetch(u.toString(), { headers: { "user-agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36", accept: "image/*" }, signal: ctl.signal });
    clearTimeout(timer);
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.startsWith("image/")) return { statusCode: 404, body: "no image" };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4_500_000) return { statusCode: 413, body: "too large" };
    return { statusCode: 200, isBase64Encoded: true, headers: { "content-type": type, "cache-control": "public, max-age=86400" }, body: buf.toString("base64") };
  } catch (e) {
    return { statusCode: 502, body: "fetch failed" };
  }
};
