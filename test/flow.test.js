// End-to-end test against an in-memory D1 and mocked Mailchimp + Mandrill.
// Run: npm test   (Node 22+, uses the built-in node:sqlite)
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { tick } from "../worker.js";

// --- tiny D1 shim ---------------------------------------------------------
function d1(sqlite) {
  const prep = (sql) => {
    const st = { sql, args: [] };
    st.bind = (...a) => { st.args = a.map((v) => (v === undefined ? null : v)); return st; };
    st.all = async () => ({ results: sqlite.prepare(sql).all(...st.args) });
    st.first = async () => sqlite.prepare(sql).get(...st.args) ?? null;
    st.run = async () => {
      if (/RETURNING/i.test(sql)) return { results: sqlite.prepare(sql).all(...st.args), meta: { changes: 1 } };
      const r = sqlite.prepare(sql).run(...st.args);
      return { meta: { changes: Number(r.changes) } };
    };
    return st;
  };
  return { prepare: prep, batch: async (sts) => { for (const s of sts) await s.run(); return []; } };
}

// --- mocked Mailchimp + Mandrill -----------------------------------------
let mcState, calls, mandrill;
function resetMocks() {
  calls = []; mandrill = [];
  mcState = { campaigns: {}, nextId: 1 };
}
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const method = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push(`${method} ${url.replace(/https:\/\/us14\.api\.mailchimp\.com\/3\.0/, "")}`);
  const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
  if (url.startsWith("https://mandrillapp.com")) { mandrill.push(body.message); return json([{ status: "sent" }]); }
  const p = new URL(url).pathname.replace("/3.0", "");
  if (p === "/lists") return json({ lists: [
    { id: "proclub1", name: "Nasiol Pro Club", stats: { member_count: 120 } },
    { id: "dist1", name: "Artekya Distributors", stats: { member_count: 34 } }] });
  if (/^\/lists\/\w+\/segments$/.test(p)) return json({ segments: p.includes("proclub1")
    ? [{ id: 777, name: "Turbo Tint", member_count: 40 }] : [] });
  if (p === "/file-manager/files" && method === "POST") {
    mcState.uploads = (mcState.uploads || 0) + 1;
    return json({ full_size_url: `https://mcusercontent.com/x/images/${body.name}` });
  }
  if (p === "/campaigns" && method === "POST") {
    const id = "mc" + mcState.nextId++;
    mcState.campaigns[id] = { status: "save", html: "", recipients: body.recipients, settings: body.settings };
    return json({ id, web_id: 555 });
  }
  let m = p.match(/^\/campaigns\/(\w+)(\/.*)?$/);
  if (m) {
    const c = mcState.campaigns[m[1]]; const sub = m[2] || "";
    if (!c) return json({ title: "Not found", detail: "no" }, 404);
    if (sub === "" && method === "PATCH") { Object.assign(c, body); return json({}); }
    if (sub === "" ) return json({ status: c.status, web_id: 555, recipients: { recipient_count: c.recipients.segment_opts ? 40 : 120 } });
    if (sub === "/content" && method === "PUT") { c.html = body.html; return json({}); }
    if (sub === "/content") return json({ html: c.html });
    if (sub === "/send-checklist") return json({ is_ready: true, items: [{ type: "success", heading: "ok", details: "" }] });
    if (sub === "/actions/send") { c.status = "sent"; return new Response(null, { status: 204 }); }
  }
  return json({ title: "unmocked", detail: p }, 500);
};

let sqlite, env;
const HTML = "<!doctype html><html><body><h1>Holiday reminder</h1><p>Hi *|FNAME|*</p></body></html>";
beforeEach(() => {
  resetMocks();
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  sqlite.exec(`CREATE TABLE ai_team_activity (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, agent TEXT NOT NULL,
    created_at TEXT NOT NULL, section TEXT NOT NULL, title TEXT NOT NULL, who TEXT, detail TEXT, link TEXT, source_ref TEXT,
    status TEXT NOT NULL DEFAULT 'open', done_at TEXT, verify TEXT, check_note TEXT, check_state TEXT);
    CREATE UNIQUE INDEX i ON ai_team_activity(agent, source_ref);`);
  env = { DB: d1(sqlite), OPS_DB: d1(sqlite), MAILCHIMP_API_KEY: "abc-us14", MANDRILL_API_KEY: "md" };
});

function queue({ key = "2026-12-01-test", audience = "nasiol pro club", tag = null, sendAt = null, auto = null } = {}) {
  const half = Math.floor(HTML.length / 2);
  sqlite.prepare(`INSERT INTO campaigns (campaign_key, title, subject, preview_text, audience_name, segment_tag, send_at, auto_send_after, html_part_count)
    VALUES (?,?,?,?,?,?,?,?,2)`).run(key, "Test title", "Holiday hours", "We close Dec 24", audience, tag, sendAt, auto);
  sqlite.prepare("INSERT INTO campaign_html_parts VALUES (?,?,?)").run(key, 1, HTML.slice(0, half));
  sqlite.prepare("INSERT INTO campaign_html_parts VALUES (?,?,?)").run(key, 2, HTML.slice(half));
  sqlite.prepare("UPDATE campaigns SET status='ready_to_build' WHERE campaign_key=?").run(key);
  return key;
}
const row = (key) => sqlite.prepare("SELECT * FROM campaigns WHERE campaign_key=?").get(key);
const reviewLink = () => mandrill.at(-1).html.match(/href="([^"]+\/review\/[^"]+)"/)[1].replace(/&amp;/g, "&");
const get = (u) => worker.fetch(new Request(u), env);
const post = (u, fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return worker.fetch(new Request(u.split("?")[0], { method: "POST", body: f }), env); };

test("full flow: build, review email, approve, send", async () => {
  await get("https://pub.example.workers.dev/");              // learns its address
  const key = queue();
  await tick(env);
  const c = row(key);
  assert.equal(c.status, "awaiting_approval", c.error);
  assert.equal(c.recipient_count, 120);
  assert.equal(mcState.campaigns.mc1.html, HTML);           // parts joined correctly
  assert.equal(mcState.campaigns.mc1.settings.subject_line, "Holiday hours");
  assert.equal(mandrill.length, 1);
  assert.match(mandrill[0].subject, /Approve email: Holiday hours/);
  assert.equal(calls.filter((x) => x.includes("actions/send")).length, 0, "never sends before approval");

  const link = reviewLink();
  const pg = await (await get(link)).text();
  assert.match(pg, /Approve and send now/);
  assert.equal(row(key).status, "awaiting_approval", "opening the link does nothing");

  const t = new URL(link).searchParams.get("t");
  const res = await (await post(link, { t, action: "approve" })).text();
  assert.match(res, /Sent/);
  assert.equal(row(key).status, "sent");
  assert.equal(mcState.campaigns.mc1.status, "sent");
  const notes = sqlite.prepare("SELECT section, title FROM ai_team_activity").all();
  assert.deepEqual(notes.map((n) => n.section), ["fyi"]);
});

test("bad token is refused", async () => {
  await get("https://pub.example.workers.dev/");
  const key = queue(); await tick(env);
  const r = await post(`https://pub.example.workers.dev/review/${key}`, { t: "nope", action: "approve" });
  assert.equal(r.status, 404);
  assert.equal(row(key).status, "awaiting_approval");
});

test("request changes needs a note, then a rebuild reuses the same Mailchimp draft", async () => {
  await get("https://pub.example.workers.dev/");
  const key = queue(); await tick(env);
  const link = reviewLink(); const t = new URL(link).searchParams.get("t");
  await post(link, { t, action: "changes" });
  assert.equal(row(key).status, "awaiting_approval", "no note -> nothing happens");
  await post(link, { t, action: "changes", note: "Say closed Dec 24-26" });
  assert.equal(row(key).status, "changes_requested");
  assert.equal(row(key).decision_note, "Say closed Dec 24-26");
  // agent revises and resubmits
  sqlite.prepare("UPDATE campaigns SET status='ready_to_build' WHERE campaign_key=?").run(key);
  await tick(env);
  assert.equal(row(key).status, "awaiting_approval");
  assert.ok(calls.some((x) => x.startsWith("PATCH /campaigns/mc1")));
  assert.equal(Object.keys(mcState.campaigns).length, 1);
  // old link retired
  assert.equal((await post(link, { t, action: "approve" })).status, 404);
});

test("edited in Mailchimp after the review email -> approve refuses", async () => {
  await get("https://pub.example.workers.dev/");
  const key = queue(); await tick(env);
  mcState.campaigns.mc1.html = HTML.replace("Holiday", "Sneaky");
  const link = reviewLink(); const t = new URL(link).searchParams.get("t");
  const txt = await (await post(link, { t, action: "approve" })).text();
  assert.match(txt, /changed in Mailchimp/);
  assert.equal(row(key).status, "awaiting_approval");
  assert.equal(mcState.campaigns.mc1.status, "save");
});

test("scheduled send waits for send_at, and can be cancelled", async () => {
  await get("https://pub.example.workers.dev/");
  const future = new Date(Date.now() + 86400e3).toISOString();
  const key = queue({ sendAt: future, tag: "Turbo Tint" }); await tick(env);
  assert.equal(row(key).recipient_count, 40);
  assert.deepEqual(mcState.campaigns.mc1.recipients.segment_opts, { saved_segment_id: 777 });
  const link = reviewLink(); const t = new URL(link).searchParams.get("t");
  assert.match(await (await post(link, { t, action: "approve" })).text(), /Approved/);
  await tick(env);
  assert.equal(row(key).status, "approved");
  sqlite.prepare("UPDATE campaigns SET send_at=? WHERE campaign_key=?").run(new Date(Date.now() - 1000).toISOString(), key);
  await tick(env);
  assert.equal(row(key).status, "sent");

  // second one: approve, then cancel from the same link
  const k2 = queue({ key: "k2", sendAt: future }); await tick(env);
  const l2 = reviewLink(); const t2 = new URL(l2).searchParams.get("t");
  await post(l2, { t: t2, action: "approve" });
  assert.match(await (await get(l2)).text(), /Cancel this send/);
  await post(l2, { t: t2, action: "cancel" });
  assert.equal(row(k2).status, "cancelled");
});

test("unknown audience fails loudly with the list of real audiences", async () => {
  const key = queue({ audience: "Nope" }); await tick(env);
  const c = row(key);
  assert.equal(c.status, "failed");
  assert.match(c.error, /Artekya Distributors \(dist1\)/);
  assert.equal(sqlite.prepare("SELECT section FROM ai_team_activity").get().section, "needs_you");
});

test("auto-send stays off unless Jeremy turns it on; reminder after 24 h", async () => {
  await get("https://pub.example.workers.dev/");
  const past = new Date(Date.now() - 1000).toISOString();
  const key = queue({ auto: past }); await tick(env);
  sqlite.prepare("UPDATE campaigns SET review_sent_at=? WHERE campaign_key=?").run(new Date(Date.now() - 25 * 3600e3).toISOString(), key);
  await tick(env);
  assert.equal(row(key).status, "awaiting_approval");
  assert.equal(mandrill.length, 2);
  assert.match(mandrill[1].subject, /Reminder/);
  await tick(env);
  assert.equal(mandrill.length, 2, "only one reminder");

  sqlite.prepare("UPDATE settings SET value='yes' WHERE key='allow_auto_send'").run();
  await tick(env);  // auto-approves
  await tick(env);  // sends
  assert.equal(row(key).status, "sent");
  assert.equal(row(key).decision, "auto_approved");
});

test("missing HTML part is caught before anything reaches Mailchimp", async () => {
  const key = queue();
  sqlite.prepare("DELETE FROM campaign_html_parts WHERE campaign_key=? AND part_no=2").run(key);
  await tick(env);
  assert.equal(row(key).status, "failed");
  assert.match(row(key).error, /part 2 of 2 is missing/);
  assert.ok(!calls.some((x) => x.startsWith("POST /campaigns")));
});

test("embedded images are uploaded to Mailchimp once and swapped for hosted URLs", async () => {
  const img = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const html = `<!doctype html><html><body><img src="data:image/png;base64,${img}"><img src='data:image/png;base64,${img}'></body></html>`;
  sqlite.prepare(`INSERT INTO campaigns (campaign_key, title, subject, audience_name, html_part_count) VALUES ('img','t','s','Nasiol Pro Club',1)`).run();
  sqlite.prepare("INSERT INTO campaign_html_parts VALUES ('img',1,?)").run(html);
  sqlite.prepare("UPDATE campaigns SET status='ready_to_build' WHERE campaign_key='img'").run();
  await tick(env);
  assert.equal(row("img").status, "awaiting_approval", row("img").error);
  const sent = mcState.campaigns.mc1.html;
  assert.ok(!sent.includes("data:image"), "no data URIs reach Mailchimp");
  assert.equal((sent.match(/mcusercontent\.com/g) || []).length, 2);
  assert.equal(mcState.uploads, 1, "same image uploaded once");
});
