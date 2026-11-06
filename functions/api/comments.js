// Bình luận theo đoạn cho blog lâu đài tình ái (bản chạy trên Cloudflare Pages).
// Lưu trong cơ sở dữ liệu D1 gắn với tên biến "DB".
// Xóa bình luận cần biến môi trường ADMIN_KEY.

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n);
const part = v => clean(v, 80).replace(/[^\p{L}\p{N}._-]/gu, "-");

let ready = false;
async function setup(db) {
  if (ready) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, story TEXT NOT NULL, ch TEXT NOT NULL, p INTEGER NOT NULL, snip TEXT, name TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS comments_by_chapter ON comments (story, ch, at)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS comment_rate (who TEXT PRIMARY KEY, t INTEGER NOT NULL)").run();
  ready = true;
}

async function sha(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  if (!db) return json({ error: "no_db" }, 500);
  await setup(db);

  const url = new URL(request.url);
  const adminKey = env.ADMIN_KEY || "";
  const isAdmin = adminKey.length >= 6 && request.headers.get("x-admin-key") === adminKey;

  if (request.method === "GET") {
    if (url.searchParams.has("check")) return json({ admin: isAdmin });
    const story = part(url.searchParams.get("story")), ch = part(url.searchParams.get("ch"));
    if (!story || !ch) return json({ error: "missing" }, 400);
    const { results } = await db.prepare(
      "SELECT id, story, ch, p, snip, name, text, at FROM comments WHERE story = ? AND ch = ? ORDER BY at"
    ).bind(story, ch).all();
    return json({ comments: results || [] });
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_json" }, 400); }

  if (request.method === "POST") {
    if (body.hp) return json({ ok: true });                       // ô bẫy chống máy gửi rác
    const story = part(body.story), ch = part(body.ch);
    const name = clean(body.name, 40), text = clean(body.text, 1500), snip = clean(body.snip, 80);
    const p = Number.isInteger(body.p) && body.p >= 0 && body.p < 10000 ? body.p : -1;
    if (!story || !ch || !name || !text || p < 0) return json({ error: "invalid" }, 400);

    // mỗi người đọc tối đa 1 bình luận mỗi 15 giây
    const who = await sha(request.headers.get("cf-connecting-ip") || "x");
    const last = await db.prepare("SELECT t FROM comment_rate WHERE who = ?").bind(who).first();
    if (last && Date.now() - last.t < 15000) return json({ error: "slow" }, 429);
    await db.prepare("INSERT INTO comment_rate (who, t) VALUES (?, ?) ON CONFLICT(who) DO UPDATE SET t = excluded.t")
      .bind(who, Date.now()).run();

    const at = Date.now();
    const id = at.toString(36) + Math.random().toString(36).slice(2, 8);
    const item = { id, story, ch, p, snip, name, text, at };
    await db.prepare("INSERT INTO comments (id, story, ch, p, snip, name, text, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, story, ch, p, snip, name, text, at).run();
    return json({ comment: item });
  }

  if (request.method === "DELETE") {
    if (!isAdmin) return json({ error: "forbidden" }, 403);
    const story = part(body.story), ch = part(body.ch), id = part(body.id);
    if (!story || !ch || !id) return json({ error: "missing" }, 400);
    await db.prepare("DELETE FROM comments WHERE id = ? AND story = ? AND ch = ?").bind(id, story, ch).run();
    return json({ ok: true });
  }

  return json({ error: "method" }, 405);
}
