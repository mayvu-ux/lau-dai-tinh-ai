// Bình luận theo đoạn cho blog lâu đài tình ái.
// Lưu trên Netlify Blobs. Xóa bình luận cần biến môi trường ADMIN_KEY.
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const clean = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, n);
const part = v => clean(v, 80).replace(/[^\p{L}\p{N}._-]/gu, "-");

export default async (req, context) => {
  const store = getStore({ name: "comments", consistency: "strong" });
  const url = new URL(req.url);
  const adminKey = process.env.ADMIN_KEY || "";
  const isAdmin = adminKey.length >= 6 && req.headers.get("x-admin-key") === adminKey;

  if (req.method === "GET") {
    if (url.searchParams.has("check")) return json({ admin: isAdmin });
    const story = part(url.searchParams.get("story")), ch = part(url.searchParams.get("ch"));
    if (!story || !ch) return json({ error: "missing" }, 400);
    const { blobs } = await store.list({ prefix: `c/${story}/${ch}/` });
    const items = (await Promise.all(blobs.map(b => store.get(b.key, { type: "json" })))).filter(Boolean);
    items.sort((a, b) => a.at - b.at);
    return json({ comments: items });
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  if (req.method === "POST") {
    if (body.hp) return json({ ok: true });                       // ô bẫy chống máy gửi rác
    const story = part(body.story), ch = part(body.ch);
    const name = clean(body.name, 40), text = clean(body.text, 1500), snip = clean(body.snip, 80);
    const p = Number.isInteger(body.p) && body.p >= 0 && body.p < 10000 ? body.p : -1;
    if (!story || !ch || !name || !text || p < 0) return json({ error: "invalid" }, 400);

    // mỗi người đọc tối đa 1 bình luận mỗi 15 giây
    const who = createHash("sha256").update(String(context?.ip || req.headers.get("x-nf-client-connection-ip") || "x")).digest("hex").slice(0, 32);
    const rate = getStore({ name: "comment-rate", consistency: "strong" });
    const last = await rate.get(who, { type: "json" });
    if (last && Date.now() - last.t < 15000) return json({ error: "slow" }, 429);
    await rate.setJSON(who, { t: Date.now() });

    const at = Date.now();
    const id = at.toString(36) + Math.random().toString(36).slice(2, 8);
    const item = { id, story, ch, p, snip, name, text, at };
    await store.setJSON(`c/${story}/${ch}/${id}`, item);
    return json({ comment: item });
  }

  if (req.method === "DELETE") {
    if (!isAdmin) return json({ error: "forbidden" }, 403);
    const story = part(body.story), ch = part(body.ch), id = part(body.id);
    if (!story || !ch || !id) return json({ error: "missing" }, 400);
    await store.delete(`c/${story}/${ch}/${id}`);
    return json({ ok: true });
  }

  return json({ error: "method" }, 405);
};

export const config = { path: "/api/comments" };
