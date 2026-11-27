// nasiol-mailchimp-campaign-publisher
//
// Gets Claude-built marketing emails into Mailchimp and out the door with one
// approval from Jeremy, and no copy-paste.
//
//   1. The marketing agent (Claude) writes a campaign row + its HTML into D1
//      `nasiol_mailchimp_campaign_publisher` through the Cloudflare connector,
//      then sets status = 'ready_to_build'.
//   2. Every 5 minutes this Worker picks it up, builds the campaign in
//      Mailchimp (audience, tag, subject, preview text, HTML), runs Mailchimp's
//      send checklist, and emails Jeremy a review link through Mandrill.
//   3. Jeremy opens the link, sees the email exactly as built, and taps
//      Approve, Request changes, or Reject. Opening the link does nothing by
//      itself (email scanners open links); only the buttons act.
//   4. On approval it sends right away, or at the campaign's send_at time.
//      Just before sending it re-checks that the Mailchimp content is still
//      the content Jeremy approved. If anyone changed it, it asks again.
//
// It never sends anything Jeremy has not approved. The one exception is a
// campaign with auto_send_after set AND settings.allow_auto_send = 'yes'
// (off by default) — Jeremy's switch, not the agent's.
//
// Secrets (Cloudflare dashboard -> this Worker -> Settings -> Variables and Secrets):
//   MAILCHIMP_API_KEY   Mailchimp Marketing API key (ends in -us14)
//   MANDRILL_API_KEY    Mailchimp Transactional key, for the review emails
// Bindings (wrangler.toml): DB (this Worker's D1), OPS_DB (proclub_registrations,
// INSERT into ai_team_activity only, so results show on the Ops Console AI Team tab).

import nasiolLockupBlackRed from "./assets/nasiol-lockup-black-red.png";

const WORKER = "nasiol-mailchimp-campaign-publisher";

// Brand images bundled with the Worker. Emails reference them as
// src="asset:<name>" and the Worker uploads them to Mailchimp once.
// To add one: drop a PNG/JPG in assets/, import it here, add it to the map.
const BRAND_ASSETS = {
  "nasiol-lockup-black-red.png": { mime: "image/png", bytes: nasiolLockupBlackRed },
};
const REVIEW_FROM_EMAIL = "support@nasiolusaproclub.com";
const REVIEW_FROM_NAME = "Nasiol Marketing Approvals";
const ET = "America/New_York";
const REMIND_AFTER_HOURS = 24;
const AUDIENCE_REFRESH_HOURS = 12;
const ROUTINE_CHECKLIST_IDS = [102, 108];

// ---------------------------------------------------------------- helpers

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

function fmtEt(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: ET, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function isPast(iso) {
  return !iso || new Date(iso).getTime() <= Date.now();
}

async function setting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

async function logEvent(env, key, event, detail) {
  await env.DB.prepare("INSERT INTO campaign_events (campaign_key, event, detail) VALUES (?,?,?)")
    .bind(key, event, detail == null ? null : String(detail).slice(0, 2000)).run();
}

async function update(env, id, fields) {
  const cols = Object.keys(fields);
  const sql = `UPDATE campaigns SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`;
  await env.DB.prepare(sql).bind(...cols.map((c) => fields[c]), nowIso(), id).run();
}

// Move a row from one status to another only if nobody else already did.
// Returns true when this call won.
async function claim(env, id, from, to) {
  const r = await env.DB.prepare(
    "UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ? AND status = ?"
  ).bind(to, nowIso(), id, from).run();
  return (r.meta && r.meta.changes) === 1;
}

// ---------------------------------------------------------------- Mailchimp

function mcBase(env) {
  const key = String(env.MAILCHIMP_API_KEY || "");
  const dc = key.includes("-") ? key.slice(key.lastIndexOf("-") + 1) : "";
  if (!dc) throw new Error("MAILCHIMP_API_KEY secret is missing or has no data-centre suffix (-us14).");
  return `https://${dc}.api.mailchimp.com/3.0`;
}

async function mc(env, method, path, body) {
  const res = await fetch(mcBase(env) + path, {
    method,
    headers: {
      Authorization: "Basic " + btoa("anystring:" + env.MAILCHIMP_API_KEY),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const detail = data && (data.detail || data.title) ? `${data.title || ""}: ${data.detail || ""}` : `HTTP ${res.status}`;
    const errs = data && data.errors ? " " + JSON.stringify(data.errors).slice(0, 400) : "";
    throw new Error(`Mailchimp ${method} ${path.split("?")[0]} failed (${res.status}) ${detail}${errs}`);
  }
  return data;
}

async function refreshAudiences(env, force = false) {
  if (!force) {
    const last = await setting(env, "audiences_refreshed_at");
    if (last && Date.now() - new Date(last).getTime() < AUDIENCE_REFRESH_HOURS * 3600e3) return;
  }
  const lists = await mc(env, "GET", "/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count");
  const stmts = [env.DB.prepare("DELETE FROM mailchimp_audiences"), env.DB.prepare("DELETE FROM mailchimp_tags")];
  for (const l of lists.lists || []) {
    stmts.push(env.DB.prepare("INSERT INTO mailchimp_audiences (list_id, name, member_count) VALUES (?,?,?)")
      .bind(l.id, l.name, l.stats ? l.stats.member_count : null));
    const segs = await mc(env, "GET",
      `/lists/${l.id}/segments?type=static&count=1000&fields=segments.id,segments.name,segments.member_count`);
    for (const s of segs.segments || []) {
      stmts.push(env.DB.prepare("INSERT INTO mailchimp_tags (list_id, tag_name, segment_id, member_count) VALUES (?,?,?,?)")
        .bind(l.id, s.name, s.id, s.member_count));
    }
  }
  stmts.push(env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('audiences_refreshed_at', ?)").bind(nowIso()));
  await env.DB.batch(stmts);
}

async function resolveRecipients(env, c) {
  await refreshAudiences(env);
  let aud = null;
  if (c.audience_id) {
    aud = await env.DB.prepare("SELECT * FROM mailchimp_audiences WHERE list_id = ?").bind(c.audience_id).first();
  } else if (c.audience_name) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM mailchimp_audiences WHERE lower(name) = lower(?)").bind(c.audience_name.trim()).all();
    if (results.length > 1) throw new Error(`More than one Mailchimp audience is named "${c.audience_name}". Use audience_id.`);
    aud = results[0] || null;
  }
  if (!aud) {
    const { results } = await env.DB.prepare("SELECT name, list_id FROM mailchimp_audiences ORDER BY name").all();
    throw new Error(`Audience not found ("${c.audience_name || c.audience_id || "none given"}"). ` +
      `Available: ${results.map((r) => `${r.name} (${r.list_id})`).join("; ")}`);
  }
  const recipients = { list_id: aud.list_id };
  if (c.segment_tag) {
    const tag = await env.DB.prepare(
      "SELECT * FROM mailchimp_tags WHERE list_id = ? AND lower(tag_name) = lower(?)"
    ).bind(aud.list_id, c.segment_tag.trim()).first();
    if (!tag) throw new Error(`Tag "${c.segment_tag}" not found in audience "${aud.name}". See table mailchimp_tags.`);
    recipients.segment_opts = { saved_segment_id: tag.segment_id };
  }
  return { recipients, audienceName: aud.name + (c.segment_tag ? ` › tag "${c.segment_tag}"` : "") };
}

async function loadHtml(env, c) {
  const { results } = await env.DB.prepare(
    "SELECT part_no, chunk FROM campaign_html_parts WHERE campaign_key = ? ORDER BY part_no"
  ).bind(c.campaign_key).all();
  const expected = Number(c.html_part_count || 1);
  const nums = results.map((r) => r.part_no);
  for (let i = 1; i <= expected; i++) {
    if (!nums.includes(i)) throw new Error(`HTML part ${i} of ${expected} is missing.`);
  }
  if (results.length !== expected) throw new Error(`Found ${results.length} HTML parts, expected ${expected}.`);
  const html = results.map((r) => r.chunk).join("");
  if (!/<html[\s>]/i.test(html) || !/<\/html>/i.test(html)) throw new Error("HTML looks incomplete (no <html>…</html>).");
  if (c.html_sha256 && (await sha256Hex(html)) !== c.html_sha256.toLowerCase()) {
    throw new Error("HTML does not match html_sha256 — parts were loaded incorrectly.");
  }
  return html;
}

async function mailchimpContentHash(env, mcId) {
  const content = await mc(env, "GET", `/campaigns/${mcId}/content?fields=html`);
  return sha256Hex(content.html || "");
}

// Images: the agent embeds them as data: URIs. Before the HTML goes to
// Mailchimp, each one is uploaded to Mailchimp's File Manager (Content Studio)
// once, and the src is swapped for the hosted URL. Same image = same URL.
function bufToB64(buf) {
  const u8 = new Uint8Array(buf); let bin = "";
  for (let i = 0; i < u8.length; i += 32768) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
  return btoa(bin);
}

async function hostImages(env, html, campaignKey) {
  // Named brand assets first: turn them into data: URIs, then the normal path uploads them.
  html = html.replace(/src=(["'])asset:([\w.-]+)\1/g, (all, q, name) => {
    const a = BRAND_ASSETS[name];
    if (!a) throw new Error(`Unknown brand asset "${name}". Available: ${Object.keys(BRAND_ASSETS).join(", ")}`);
    return `src=${q}data:${a.mime};base64,${bufToB64(a.bytes)}${q}`;
  });
  const re = /src=(["'])data:(image\/(?:png|jpe?g|gif));base64,([A-Za-z0-9+/=\s]+)\1/g;
  const found = [...html.matchAll(re)];
  if (!found.length) return html;
  const urls = new Map();
  for (const m of found) {
    const b64 = m[3].replace(/\s+/g, "");
    if (urls.has(b64)) continue;
    const hash = await sha256Hex(b64);
    let row = await env.DB.prepare("SELECT url FROM hosted_images WHERE sha256 = ?").bind(hash).first();
    if (!row) {
      const ext = m[2].split("/")[1].replace("jpeg", "jpg");
      const up = await mc(env, "POST", "/file-manager/files", {
        name: `publisher-${hash.slice(0, 12)}.${ext}`, file_data: b64,
      });
      row = { url: up.full_size_url };
      await env.DB.prepare("INSERT OR REPLACE INTO hosted_images (sha256, url, uploaded_at) VALUES (?,?,?)")
        .bind(hash, row.url, nowIso()).run();
      await logEvent(env, campaignKey, "image_hosted", row.url);
    }
    urls.set(b64, row.url);
  }
  return html.replace(re, (all, q, mime, data) => `src=${q}${urls.get(data.replace(/\s+/g, ""))}${q}`);
}

// ---------------------------------------------------------------- Mandrill

async function sendMandrill(env, { to, subject, html, text }) {
  if (!env.MANDRILL_API_KEY) throw new Error("MANDRILL_API_KEY secret is missing.");
  const res = await fetch("https://mandrillapp.com/api/1.0/messages/send.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: env.MANDRILL_API_KEY,
      message: {
        from_email: REVIEW_FROM_EMAIL, from_name: REVIEW_FROM_NAME,
        to: [{ email: to, type: "to" }],
        subject, html, text,
        track_opens: false,
        track_clicks: false, // never rewrite the signed review link
        auto_text: !text,
      },
    }),
  });
  const data = await res.json().catch(() => null);
  const r = Array.isArray(data) ? data[0] : null;
  if (!res.ok || !r || !["sent", "queued", "scheduled"].includes(r.status)) {
    throw new Error(`Mandrill send failed: ${JSON.stringify(data).slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------- Ops Console

// INSERT-only into the AI Team tab (knowledge/systems/ai-team-activity.md).
async function opsNote(env, c, section, title, detail, link) {
  if (!env.OPS_DB) return;
  try {
    await env.OPS_DB.prepare(
      `INSERT OR IGNORE INTO ai_team_activity
         (run_id, agent, created_at, section, title, who, detail, link, source_ref)
       VALUES (NULL, 'marketing', ?, ?, ?, ?, ?, ?, ?)`
    ).bind(nowIso(), section, title.slice(0, 90), "Mailchimp", detail.slice(0, 600), link || null,
      `mailchimp-campaign:${c.campaign_key}:${section}:${nowIso()}`).run();
  } catch (e) {
    await logEvent(env, c.campaign_key, "ops_note_failed", e.message);
  }
}

// ---------------------------------------------------------------- build

async function build(env, c) {
  if (!(await claim(env, c.id, "ready_to_build", "building"))) return;
  try {
    const html = await loadHtml(env, c);
    const { recipients, audienceName } = await resolveRecipients(env, c);
    const settings = {
      subject_line: c.subject,
      preview_text: c.preview_text || "",
      title: c.title,
      from_name: c.from_name,
      reply_to: c.reply_to,
    };

    let mcId = c.mailchimp_campaign_id;
    if (mcId) {
      // Rebuild after "request changes": reuse the same draft if it's still a draft.
      const existing = await mc(env, "GET", `/campaigns/${mcId}?fields=status`).catch(() => null);
      if (!existing || existing.status !== "save") mcId = null;
    }
    if (mcId) {
      await mc(env, "PATCH", `/campaigns/${mcId}`, { recipients, settings });
    } else {
      const created = await mc(env, "POST", "/campaigns", { type: "regular", recipients, settings });
      mcId = created.id;
      await update(env, c.id, { mailchimp_campaign_id: mcId, mailchimp_web_id: String(created.web_id || "") });
    }
    await mc(env, "PUT", `/campaigns/${mcId}/content`, { html: await hostImages(env, html, c.campaign_key) });

    const info = await mc(env, "GET", `/campaigns/${mcId}?fields=recipients.recipient_count,web_id`);
    const checklist = await mc(env, "GET", `/campaigns/${mcId}/send-checklist`);
    const mcHash = await mailchimpContentHash(env, mcId);

    const token = randomToken();
    await update(env, c.id, {
      status: "awaiting_approval",
      audience_resolved_name: audienceName,
      recipient_count: info.recipients ? info.recipients.recipient_count : null,
      checklist_json: JSON.stringify(checklist),
      approved_html_sha256: null,
      review_token_hash: await sha256Hex(token),
      review_sent_at: nowIso(),
      reminder_sent_at: null,
      decision: null, decision_note: null, decided_at: null, error: null,
      // what Jeremy is about to review, as Mailchimp holds it
      html_sha256: c.html_sha256 || (await sha256Hex(html)),
    });
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
      .bind(`review_mc_hash:${c.campaign_key}`, mcHash).run();
    await logEvent(env, c.campaign_key, "built", `Mailchimp ${mcId}, ${audienceName}, ${info.recipients?.recipient_count} recipients`);

    const fresh = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(c.id).first();
    await sendReviewEmail(env, fresh, token, false);
  } catch (e) {
    await update(env, c.id, { status: "failed", error: e.message.slice(0, 1500) });
    await logEvent(env, c.campaign_key, "build_failed", e.message);
    await opsNote(env, c, "needs_you", `Email could not be built: ${c.subject}`,
      `The Mailchimp publisher stopped before review. Reason: ${e.message}`);
  }
}

// ---------------------------------------------------------------- review email + page

async function reviewUrl(env, c, token) {
  const base = await setting(env, "public_base_url");
  return base ? `${base.replace(/\/$/, "")}/review/${encodeURIComponent(c.campaign_key)}?t=${token}` : null;
}

function checklistItems(c) {
  try {
    const cl = JSON.parse(c.checklist_json || "{}");
    // Hide Mailchimp's routine notices so only real problems show:
    // 102 = default CAN-SPAM footer added (expected), 108 = no referral link.
    return (cl.items || []).filter((i) => i.type !== "success" && !ROUTINE_CHECKLIST_IDS.includes(i.id));
  } catch { return []; }
}

async function sendReviewEmail(env, c, token, isReminder) {
  const to = (await setting(env, "approver_email")) || "jeremy@artekya.com";
  const url = await reviewUrl(env, c, token);
  const when = c.send_at && !isPast(c.send_at) ? fmtEt(c.send_at) : "As soon as you approve";
  const issues = checklistItems(c);
  const issuesHtml = issues.length
    ? `<p style="margin:16px 0 4px;font-weight:bold;color:#b00020">Mailchimp flagged:</p><ul style="margin:0;padding-left:20px">${
      issues.map((i) => `<li>${esc(i.heading)}: ${esc(i.details)}</li>`).join("")}</ul>` : "";
  const button = url
    ? `<p style="margin:24px 0"><a href="${esc(url)}" style="background:#d6001c;color:#fff;text-decoration:none;font-weight:bold;padding:14px 26px;border-radius:6px;display:inline-block">Review and approve</a></p>`
    : `<p style="color:#b00020"><b>Setup step missing:</b> open the Worker's URL once in a browser so it learns its own address, then this email will carry the review button.</p>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:560px">
<p>${isReminder ? "Reminder: this email is still waiting on you." : "An email is ready for your approval."}</p>
<table style="border-collapse:collapse;font-size:15px">
<tr><td style="padding:3px 12px 3px 0;color:#666">Subject</td><td><b>${esc(c.subject)}</b></td></tr>
<tr><td style="padding:3px 12px 3px 0;color:#666">To</td><td>${esc(c.audience_resolved_name)} — ${esc(c.recipient_count ?? "?")} recipients</td></tr>
<tr><td style="padding:3px 12px 3px 0;color:#666">Sends</td><td>${esc(when)}</td></tr>
</table>
${c.notes_for_reviewer ? `<p style="margin:16px 0 0">${esc(c.notes_for_reviewer)}</p>` : ""}
${issuesHtml}
${button}
<p style="color:#666;font-size:13px">Nothing sends until you tap Approve on that page.</p>
</div>`;
  const text = `${isReminder ? "Reminder: " : ""}Email ready for approval\nSubject: ${c.subject}\nTo: ${c.audience_resolved_name} (${c.recipient_count} recipients)\nSends: ${when}\n\nReview: ${url || "(open the Worker URL once to enable links)"}\n`;
  await sendMandrill(env, { to, subject: `${isReminder ? "Reminder — approve" : "Approve"} email: ${c.subject}`, html, text });
  await logEvent(env, c.campaign_key, isReminder ? "reminder_sent" : "review_sent", to);
}

const PAGE_CSS = `
:root{--bg:#f4f4f5;--card:#fff;--ink:#111;--muted:#666;--line:#ddd;--red:#d6001c;--ok:#137333;--warn:#b00020}
@media (prefers-color-scheme:dark){:root{--bg:#121214;--card:#1c1c1f;--ink:#eee;--muted:#aaa;--line:#333}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:14px}
h1{font-size:20px;margin:0 0 10px}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.warn{color:var(--warn)}.ok{color:var(--ok)}
iframe{width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:#fff}
textarea{width:100%;min-height:70px;font:inherit;padding:8px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.btns{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:12px 18px;cursor:pointer}
.approve{background:var(--red);color:#fff;flex:1 1 100%}.changes{background:#444;color:#fff;flex:1}.reject{background:transparent;color:var(--warn);border:1px solid var(--warn);flex:1}
.muted{color:var(--muted);font-size:14px}`;

function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

async function findByToken(env, key, token) {
  if (!key || !token) return null;
  const c = await env.DB.prepare("SELECT * FROM campaigns WHERE campaign_key = ?").bind(key).first();
  if (!c || !c.review_token_hash) return null;
  return (await sha256Hex(token)) === c.review_token_hash ? c : null;
}

async function reviewPage(env, key, token) {
  const c = await findByToken(env, key, token);
  if (!c) return page("Link not valid", `<div class="card"><h1>This review link isn't valid</h1><p>It may have been replaced by a newer version of the email. Use the newest approval email.</p></div>`, 404);

  const summary = `<dl>
<dt>Subject</dt><dd><b>${esc(c.subject)}</b></dd>
<dt>Preview text</dt><dd>${esc(c.preview_text || "—")}</dd>
<dt>To</dt><dd>${esc(c.audience_resolved_name)} — ${esc(c.recipient_count ?? "?")} recipients</dd>
<dt>From</dt><dd>${esc(c.from_name)} &lt;${esc(c.reply_to)}&gt;</dd>
<dt>Sends</dt><dd>${c.send_at && !isPast(c.send_at) ? esc(fmtEt(c.send_at)) : "As soon as you approve"}</dd>
</dl>${c.notes_for_reviewer ? `<p>${esc(c.notes_for_reviewer)}</p>` : ""}`;

  if (c.status !== "awaiting_approval") {
    const state = {
      approved: `<p class="ok"><b>Approved.</b> Sends ${esc(fmtEt(c.send_at))}.</p>
        <form method="post"><input type="hidden" name="t" value="${esc(token)}"><input type="hidden" name="action" value="cancel">
        <div class="btns"><button class="reject">Cancel this send</button></div></form>`,
      sending: `<p>Sending now…</p>`,
      sent: `<p class="ok"><b>Sent</b> ${esc(fmtEt(c.sent_at))}.</p>`,
      changes_requested: `<p>You asked for changes: “${esc(c.decision_note)}”. A new version will come to you for approval.</p>`,
      rejected: `<p>Rejected. Nothing was sent.</p>`,
      cancelled: `<p>Cancelled. Nothing was sent.</p>`,
      failed: `<p class="warn"><b>Problem:</b> ${esc(c.error)}</p>`,
    }[c.status] || `<p>Status: ${esc(c.status)}</p>`;
    return page(c.subject, `<div class="card"><h1>${esc(c.subject)}</h1>${state}${summary}</div>`);
  }

  const html = await loadHtml(env, c).catch(() => "<p>Preview unavailable.</p>");
  const issues = checklistItems(c);
  const issuesHtml = issues.length
    ? `<div class="card"><b class="warn">Mailchimp flagged:</b><ul>${issues.map((i) =>
      `<li class="${i.type === "error" ? "warn" : ""}">${esc(i.heading)}: ${esc(i.details)}</li>`).join("")}</ul></div>` : "";
  const blocked = issues.some((i) => i.type === "error");
  const approveLabel = c.send_at && !isPast(c.send_at) ? `Approve — sends ${fmtEt(c.send_at)}` : "Approve and send now";

  return page(`Approve: ${c.subject}`, `
<div class="card"><h1>Approve this email?</h1>${summary}</div>
${issuesHtml}
<div class="card"><iframe sandbox title="Email preview" srcdoc="${esc(html)}"></iframe>
<p class="muted">Preview of the HTML loaded into Mailchimp. Mailchimp adds its standard footer when it sends.</p></div>
<div class="card"><form method="post">
<input type="hidden" name="t" value="${esc(token)}">
<label class="muted" for="note">Note (needed for “Request changes”)</label>
<textarea id="note" name="note" placeholder="What should change?"></textarea>
<div class="btns">
${blocked ? `<p class="warn">Mailchimp says this can't send until the flagged error is fixed. Use Request changes.</p>`
    : `<button class="approve" name="action" value="approve">${esc(approveLabel)}</button>`}
<button class="changes" name="action" value="changes">Request changes</button>
<button class="reject" name="action" value="reject">Reject</button>
</div></form></div>`);
}

async function reviewPost(env, key, request) {
  const form = await request.formData();
  const token = String(form.get("t") || "");
  const action = String(form.get("action") || "");
  const note = String(form.get("note") || "").trim().slice(0, 2000);
  const c = await findByToken(env, key, token);
  if (!c) return page("Link not valid", `<div class="card"><h1>This review link isn't valid</h1></div>`, 404);
  const back = `<p><a href="?t=${encodeURIComponent(token)}">Back</a></p>`;

  if (action === "cancel") {
    if (!(await claim(env, c.id, "approved", "cancelled"))) {
      return page("Too late", `<div class="card"><h1>Couldn't cancel</h1><p>It's already ${esc(c.status)}.</p>${back}</div>`);
    }
    await logEvent(env, key, "cancelled_by_jeremy", null);
    return page("Cancelled", `<div class="card"><h1>Cancelled</h1><p>Nothing will be sent.</p></div>`);
  }

  if (c.status !== "awaiting_approval") {
    return page("Already decided", `<div class="card"><h1>Already decided</h1><p>Status: ${esc(c.status)}.</p>${back}</div>`);
  }

  if (action === "changes" || action === "reject") {
    if (action === "changes" && !note) {
      return page("Add a note", `<div class="card"><h1>What should change?</h1><p>Add a note so the change can be made, then tap Request changes again.</p>${back}</div>`);
    }
    const to = action === "changes" ? "changes_requested" : "rejected";
    if (!(await claim(env, c.id, "awaiting_approval", to))) return page("Already decided", `<div class="card"><h1>Already decided</h1>${back}</div>`);
    await update(env, c.id, { decision: to, decision_note: note || null, decided_at: nowIso() });
    await logEvent(env, key, to, note);
    await opsNote(env, c, action === "changes" ? "needs_you" : "fyi",
      action === "changes" ? `Changes requested: ${c.subject}` : `Email rejected: ${c.subject}`,
      action === "changes"
        ? `Jeremy asked for changes: "${note}". The marketing agent revises and resubmits; he gets a new approval email.`
        : `Rejected${note ? `: "${note}"` : ""}. Nothing was sent.`);
    return page("Got it", `<div class="card"><h1>${action === "changes" ? "Changes requested" : "Rejected"}</h1><p>${
      action === "changes" ? "A revised version will come to you for approval." : "Nothing was sent."}</p></div>`);
  }

  if (action === "approve") {
    if (checklistItems(c).some((i) => i.type === "error")) {
      return page("Can't send yet", `<div class="card"><h1>Mailchimp blocked this send</h1><p>Use Request changes.</p>${back}</div>`);
    }
    // Make sure Mailchimp still holds exactly what this page showed.
    const reviewed = await setting(env, `review_mc_hash:${key}`);
    const current = await mailchimpContentHash(env, c.mailchimp_campaign_id);
    if (reviewed && current !== reviewed) {
      return page("Changed", `<div class="card"><h1>The email changed in Mailchimp after this review was sent</h1><p>Nothing was sent. Ask for a fresh review.</p></div>`);
    }
    if (!(await claim(env, c.id, "awaiting_approval", "approved"))) return page("Already decided", `<div class="card"><h1>Already decided</h1>${back}</div>`);
    await update(env, c.id, { decision: "approved", decision_note: note || null, decided_at: nowIso(), approved_html_sha256: current });
    await logEvent(env, key, "approved", note);
    if (isPast(c.send_at)) {
      const fresh = await env.DB.prepare("SELECT * FROM campaigns WHERE id = ?").bind(c.id).first();
      const ok = await sendNow(env, fresh);
      return page(ok ? "Sent" : "Problem", ok
        ? `<div class="card"><h1 class="ok">Sent</h1><p>${esc(c.subject)} is on its way to ${esc(c.recipient_count)} recipients.</p></div>`
        : `<div class="card"><h1 class="warn">Approved, but the send failed</h1><p>${esc((await env.DB.prepare("SELECT error FROM campaigns WHERE id=?").bind(c.id).first()).error)}</p></div>`);
    }
    return page("Approved", `<div class="card"><h1 class="ok">Approved</h1><p>Sends ${esc(fmtEt(c.send_at))}. You can cancel from this same link until then.</p></div>`);
  }

  return page("Unknown action", `<div class="card"><h1>Unknown action</h1>${back}</div>`, 400);
}

// ---------------------------------------------------------------- send

async function sendNow(env, c) {
  if (!(await claim(env, c.id, "approved", "sending"))) return false;
  try {
    const camp = await mc(env, "GET", `/campaigns/${c.mailchimp_campaign_id}?fields=status,recipients.recipient_count`);
    if (camp.status !== "save") throw new Error(`Mailchimp campaign is "${camp.status}", not a draft — not sending again.`);
    const current = await mailchimpContentHash(env, c.mailchimp_campaign_id);
    if (c.approved_html_sha256 && current !== c.approved_html_sha256) {
      // Edited in Mailchimp after approval. Don't send something Jeremy didn't
      // see, and don't overwrite the edit either: stop and tell him.
      throw new Error("The email was edited in Mailchimp after you approved it, so it was not sent. " +
        "Ask for a fresh review of the current version.");
    }
    const checklist = await mc(env, "GET", `/campaigns/${c.mailchimp_campaign_id}/send-checklist`);
    if (!checklist.is_ready) {
      throw new Error("Mailchimp send checklist not ready: " +
        (checklist.items || []).filter((i) => i.type === "error").map((i) => `${i.heading}: ${i.details}`).join("; "));
    }
    await mc(env, "POST", `/campaigns/${c.mailchimp_campaign_id}/actions/send`);
    await update(env, c.id, { status: "sent", sent_at: nowIso(), recipient_count: camp.recipients?.recipient_count ?? c.recipient_count, error: null });
    await logEvent(env, c.campaign_key, "sent", `${camp.recipients?.recipient_count} recipients`);
    await opsNote(env, c, "fyi", `Email sent: ${c.subject}`,
      `Sent to ${c.audience_resolved_name}, ${camp.recipients?.recipient_count ?? c.recipient_count} recipients, after your approval.`,
      c.mailchimp_web_id ? `${mcBase(env).replace(/\/\/(\w+)\.api\.mailchimp\.com\/3\.0$/, "//$1.admin.mailchimp.com")}/reports/summary?id=${c.mailchimp_web_id}` : null);
    return true;
  } catch (e) {
    await update(env, c.id, { status: "failed", error: e.message.slice(0, 1500) });
    await logEvent(env, c.campaign_key, "send_failed", e.message);
    await opsNote(env, c, "needs_you", `Approved email did not send: ${c.subject}`, `Reason: ${e.message}`);
    try {
      await sendMandrill(env, {
        to: (await setting(env, "approver_email")) || "jeremy@artekya.com",
        subject: `Send failed: ${c.subject}`,
        html: `<p>The email you approved did not send.</p><p><b>Reason:</b> ${esc(e.message)}</p><p>Nothing went out.</p>`,
      });
    } catch { /* already recorded */ }
    return false;
  }
}

// ---------------------------------------------------------------- cron

async function tick(env) {
  // 1. Build anything the agent finished loading.
  const { results: toBuild } = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE status = 'ready_to_build' ORDER BY id LIMIT 5").all();
  for (const c of toBuild) await build(env, c);

  // 2. Send approved campaigns whose time has come.
  const { results: due } = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE status = 'approved' ORDER BY id LIMIT 10").all();
  for (const c of due) if (isPast(c.send_at)) await sendNow(env, c);

  // 3. Waiting on Jeremy: one reminder, and the opt-in auto-send.
  const allowAuto = (await setting(env, "allow_auto_send")) === "yes";
  const { results: waiting } = await env.DB.prepare(
    "SELECT * FROM campaigns WHERE status = 'awaiting_approval' ORDER BY id LIMIT 20").all();
  for (const c of waiting) {
    if (allowAuto && c.auto_send_after && isPast(c.auto_send_after)) {
      if (checklistItems(c).some((i) => i.type === "error")) continue;
      const reviewed = await setting(env, `review_mc_hash:${c.campaign_key}`);
      if (!(await claim(env, c.id, "awaiting_approval", "approved"))) continue;
      await update(env, c.id, { decision: "auto_approved", decided_at: nowIso(), approved_html_sha256: reviewed });
      await logEvent(env, c.campaign_key, "auto_approved", `No decision by ${c.auto_send_after}`);
      continue; // picked up by step 2 on the next tick, after send_at
    }
    if (!c.reminder_sent_at && c.review_sent_at &&
        Date.now() - new Date(c.review_sent_at).getTime() > REMIND_AFTER_HOURS * 3600e3) {
      // Only a hash of each link is stored, so the reminder carries a new link and the first one retires.
      const token = randomToken();
      await update(env, c.id, { review_token_hash: await sha256Hex(token), reminder_sent_at: nowIso() });
      await sendReviewEmail(env, c, token, true).catch((e) => logEvent(env, c.campaign_key, "reminder_failed", e.message));
    }
  }

  // 4. Keep the audience/tag list fresh for the agent to read.
  await refreshAudiences(env).catch((e) => logEvent(env, "-", "audience_refresh_failed", e.message));
}

// ---------------------------------------------------------------- entry

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Learn our own public address so the cron's review emails can link here.
    const origin = url.origin;
    if (!origin.includes("localhost") && !origin.includes("127.0.0.1")) {
      const known = await setting(env, "public_base_url");
      if (known !== origin) {
        await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('public_base_url', ?)").bind(origin).run();
      }
    }

    const m = url.pathname.match(/^\/review\/([^/]+)\/?$/);
    if (m) {
      const key = decodeURIComponent(m[1]);
      try {
        if (request.method === "POST") return await reviewPost(env, key, request);
        return await reviewPage(env, key, url.searchParams.get("t"));
      } catch (e) {
        return page("Error", `<div class="card"><h1>Something went wrong</h1><p>${esc(e.message)}</p><p>Nothing was sent.</p></div>`, 500);
      }
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      const { results } = await env.DB.prepare(
        "SELECT status, COUNT(*) AS n FROM campaigns GROUP BY status").all();
      return Response.json({
        worker: WORKER,
        secrets: { MAILCHIMP_API_KEY: !!env.MAILCHIMP_API_KEY, MANDRILL_API_KEY: !!env.MANDRILL_API_KEY },
        ops_console_link: !!env.OPS_DB,
        public_base_url: origin,
        campaigns_by_status: results,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    return new Response("Not found", { status: 404 });
  },
};

// exported for tests
export { tick, build, sendNow, reviewPage, reviewPost, sha256Hex };
