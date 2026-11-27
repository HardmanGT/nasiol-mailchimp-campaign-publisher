# nasiol-mailchimp-campaign-publisher

Gets marketing emails that Claude builds into Mailchimp and sent, with one
approval from Jeremy and no copy-paste. Separate from `nasiol-warranty-payment`
(the Ops Console).

## Names (keep these identical everywhere)
| Piece | Name |
|---|---|
| GitHub repo | `HardmanGT/nasiol-mailchimp-campaign-publisher` |
| Cloudflare Worker | `nasiol-mailchimp-campaign-publisher` |
| D1 database | `nasiol_mailchimp_campaign_publisher` (id `2606741b-af4d-45d8-8395-9f5604c05c99`) |
| AI-team seat that feeds it | `marketing` (`nasiol-ai-team/agents/marketing.md`) |

## How it works
1. **Claude loads the email.** The marketing agent inserts a row in `campaigns`
   and the HTML in `campaign_html_parts` through the Cloudflare connector, then
   sets `status = 'ready_to_build'`. Exact SQL:
   `nasiol-ai-team/knowledge/systems/mailchimp-campaign-publisher.md`.
2. **The Worker builds it** (every 5 minutes): Mailchimp campaign with audience,
   optional tag, subject, preview text, from name, reply-to and the HTML. It
   runs Mailchimp's send checklist.
3. **Jeremy gets one email** (via Mandrill, from support@nasiolusaproclub.com)
   with a **Review and approve** button. The page shows the email as built,
   who it goes to, how many people, when it sends, and anything Mailchimp
   flagged. Buttons: **Approve**, **Request changes** (with a note), **Reject**.
   Opening the link does nothing; only the buttons act, so email link scanners
   can't approve anything.
4. **On approval** it sends immediately, or at `send_at`. Until then the same
   link has a **Cancel this send** button.
5. **Just before sending** it checks the Mailchimp draft still holds exactly
   what Jeremy approved, and re-runs the send checklist. If anything changed,
   it does not send and tells him.
6. **Results** (sent, rejected, changes requested, failures) go to the Ops
   Console AI Team tab, INSERT-only into `ai_team_activity`. Failures also
   email Jeremy.

No reply after 24 hours: one reminder email with a fresh link.

## Images
- **Brand assets** live in `assets/` and are bundled into the Worker. In email
  HTML write `<img src="asset:nasiol-lockup-black-red.png">`. The Worker uploads
  the file to Mailchimp's File Manager once and swaps in the hosted URL.
  To add one: put the file in `assets/`, import it in `worker.js`, add it to `BRAND_ASSETS`.
- **One-off images** can be embedded as `data:image/png;base64,…`; same upload path.

## The auto-send switch (off)
`settings.allow_auto_send` is `no`. While it is `no`, nothing sends without
Jeremy's tap. If Jeremy sets it to `yes`, a campaign that carries
`auto_send_after` sends when that time passes with no decision. Only Jeremy
flips this; agents never do.

## Tables
| Table | What it holds |
|---|---|
| `campaigns` | One row per email: content settings, audience, timing, status, Mailchimp ids, decision |
| `campaign_html_parts` | The HTML, split into parts (one D1 statement caps near 100 KB) |
| `campaign_events` | Audit trail: built, review_sent, approved, sent, failures |
| `settings` | `approver_email`, `allow_auto_send`, `public_base_url` (learned automatically) |
| `mailchimp_audiences`, `mailchimp_tags` | Refreshed every 12 h so the agent can see real audience and tag names |

Status path: `loading → ready_to_build → building → awaiting_approval → approved → sending → sent`.
Side exits: `changes_requested`, `rejected`, `cancelled`, `failed`.

## Setup (one time)
1. Cloudflare → Workers & Pages → Create → Import a repository → this repo.
   Builds deploy from `main`.
2. Worker → Settings → Variables and Secrets → add secrets
   `MAILCHIMP_API_KEY` and `MANDRILL_API_KEY`.
3. Open the Worker's workers.dev URL once. It shows a status page and records
   its own address so review emails can link back to it.

## Changes
- Deploy: push to `main` (Workers Builds).
- Tests: `npm test` runs the full flow against mocked Mailchimp and Mandrill.
- Change approver: `UPDATE settings SET value = '…' WHERE key = 'approver_email'`.
