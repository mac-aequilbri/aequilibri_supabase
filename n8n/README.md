# n8n workflows

Importable workflow definitions for the integration layer. Design rationale and the wider rollout
plan live in [`docs/n8n-automation-plan.md`](../docs/n8n-automation-plan.md).

Instance: `https://aequilibri.app.n8n.cloud`.

> **2026-07-30 — Postgres migration (plan Phase 6).** The Airtable backend is decommissioned; the
> outbound queue lives in the platform's control DATABASE. The outbound workflow no longer polls
> Airtable's `PLAT_OUTBOX` table — it polls the app's authenticated feed:
>
> - `GET  /api/platform/outbox` — pending events (JSON `{ events: [...] }`, oldest first, ids are
>   Postgres numeric ids as strings)
> - `POST /api/platform/outbox` — `{ id, status: "delivered"|"failed", error? }`
> - Auth: `Authorization: Bearer <OUTBOX_FEED_SECRET>` (falls back to `PLATFORM_WEBHOOK_SECRET`).
>   Set `OUTBOX_FEED_SECRET` as an n8n **Variable** (`$vars`, NOT `$env` — n8n Cloud) and in the
>   app's environment.
>
> The Airtable credential and control-base references below are HISTORICAL — kept for context until
> the demo walkthrough is re-verified against the feed. Inbound workflows are unchanged (they call
> the app's webhook, which has been Postgres-native since Phase 3).

| File | Purpose |
| --- | --- |
| `demo-sunridge-inbound.json` | Demo: read email from `mac@aequilibri` into the platform as org `sunridge`. |
| `demo-sunridge-outbound.json` | Demo: deliver platform events back to `mac@aequilibri`. |
| `workflow-a-inbound-email.json` | The general per-client inbound template (currently set to `dulong-downs-didi`). |

---

# The two-way demo (sunridge ↔ mac@aequilibri)

Goal: prove the platform can **read** email from `mac@aequilibri` and **send** back to it. One
mailbox, one Gmail credential, both directions.

`CRON_SECRET` is **not** needed for this. It only drives the retry sweep for *failed* deliveries;
enqueue-on-event and n8n's own polling both work without it.

## Step 0 — Render configuration

**Nothing needs changing on Render for this demo.** Verified 2026-07-29 against the live service:

| Variable | State | Needed here? |
| --- | --- | --- |
| `AIRTABLE_MIGRATION` | `true` (declared in `render.yaml`) | yes — already on |
| `AIRTABLE_CONTROL_BASE_ID` | `app51Tmrgab3QYP4Z`, set in the dashboard | yes — already on |
| `AIRTABLE_PAT` | set | yes — already on |
| Clerk keys | set (prod) | yes — already on |
| `PLATFORM_WEBHOOK_SECRET` | unset | **no** — sunridge uses a per-org secret, which takes precedence |
| `CRON_SECRET` | unset (scheduler returns 503) | **no** — only re-drives *failed* deliveries |

How each was verified rather than assumed: the inbound webhook returning **403 "Channel not enabled"**
to a correctly-signed request proves `controlEnabled()` is true in production, which requires both
`AIRTABLE_MIGRATION` and `AIRTABLE_CONTROL_BASE_ID`. `/api/health` reports `airtable_config: ok` and
`auth_config: ok`.

Two things worth knowing:

- **`AIRTABLE_CONTROL_BASE_ID` was missing from `render.yaml`** until 2026-07-29 — set in the
  dashboard only. A fresh blueprint deploy would have come up with the entire control plane silently
  off (no org registry, no PLAT_TEAM auth, no default-deny, no outbox). Now declared.
- **`plan: free` spins the service down when idle**, and a cold start takes 30–60s. n8n's HTTP node
  will usually ride that out, but the first delivery after a quiet period can look like a hang. If
  the demo needs to be crisp, warm the service first by loading any page.

## Step 1 — platform side (once)

**a. Give sunridge a webhook secret.** ✅ **Done 2026-07-29** — the endpoint flipped 503 → 401, and a
properly-signed request then reached the default-deny gate (403), confirming the HMAC scheme works
end-to-end. Re-run only to rotate. For a new org:

```bash
node scripts/airtable-set-webhook-secret.mjs sunridge
```

That generates one, writes it into `PLAT_ORG_REGISTRY` → the sunridge row → `Settings` JSON, and
prints it. Keep the printed value for step 2a. (Pass an explicit secret as a second argument to set
a specific one; `--show` reads the current value without changing it.)

**b. Add both connection rows** at `/app/sunridge/integrations` → *Add a channel*:

| Channel | Direction | Credential ref |
| --- | --- | --- |
| `email` | `in (ingest)` | `n8n:gmail-mac` |
| `email` | `out (deliver)` | `n8n:gmail-mac` |

New rows are created **active**, so no extra toggle. Both are load-bearing: without the `in` row the
webhook returns 403, and without the `out` row `emitOutboundEvent` silently no-ops and nothing ever
reaches the outbox.

Access note: with Clerk on, reaching this page needs an active member row in sunridge's `PLAT_TEAM`,
and the *Add a channel* form needs role `owner`. `PLATFORM_ADMIN_EMAILS` does **not** grant this — it
only gates provisioning new orgs and widens the org-picker list. Verified 2026-07-29:
`mac@aequilibri.com` is already an active `owner` on sunridge, so no team change is needed.

**c. Confirm the rows took effect.** Before the rows exist a signed request returns
403 "Channel 'email' is not enabled"; after they exist it returns **200** with `{ "ok": true, ... }`.
That 403 → 200 flip is the checkpoint — it means the whole platform path works and only n8n is left.
The control cache is 60s, so allow a minute:

```bash
AEQ_WEBHOOK_SECRET="<secret from step 1a>" node scripts/send-test-webhook.mjs sunridge
```

A 200 here also creates a real document in the sunridge base (the synthetic plasterboard message),
so expect a test row under Documents — delete it before demoing if you want a clean slate.

## Step 2 — n8n side (once)

**a. Paste the signing secret into the workflow.** These workflows deliberately do **not** use n8n
Variables — creating them needs instance-admin rights, which a member account doesn't have. Instead,
after importing the inbound workflow, open the **Sign (HMAC-SHA256)** node and replace the literal
`PASTE_SUNRIDGE_WEBHOOK_SECRET_HERE` in the *Secret* field with the value from step 1a.

The control base id (`app51Tmrgab3QYP4Z`) is hardcoded in the outbound workflow's two Airtable URLs —
it isn't a secret, so no action needed there.

> **Trade-off:** a pasted secret is stored in the workflow and appears in any export, whereas a
> Variable would be referenced by name. That's acceptable for a demo with a rotatable secret, but
> before onboarding real clients get an instance admin to create Variables (`$vars.AEQ_SECRET_<ORG>`)
> and switch the Secret field back to an expression. Rotate with
> `node scripts/airtable-set-webhook-secret.mjs sunridge` whenever you need to.

**b. Credentials.** Two are needed, but **neither is required for the inbound manual test** — that
path uses no credentials at all, so prove inbound first and add these when you're ready to activate.

| Credential | n8n type | Used by | Needed for |
| --- | --- | --- | --- |
| Gmail OAuth2 | `Gmail OAuth2 API` | Gmail Trigger (inbound), Gmail Send (outbound) | activating inbound; sending outbound |
| Airtable PAT | `Airtable Personal Access Token API` (`airtableTokenApi`) | both outbound HTTP nodes | outbound only |

- **Gmail** — Credentials → Create credential → *Gmail OAuth2 API*, then complete Google's consent as
  `mac@aequilibri.com`. Attach it to the Gmail Trigger in the inbound workflow and to the Gmail Send
  node in the outbound one (same credential, both places).
- **Airtable** — Credentials → Create credential → *Airtable Personal Access Token API*, paste a PAT
  with `data.records:read` + `data.records:write` on control base `app51Tmrgab3QYP4Z`. The
  `AIRTABLE_PAT` in `.env` works, though it is broader than this needs; a base-scoped token is
  tidier. Attach it to **both** HTTP Request nodes in the outbound workflow — they authenticate via
  *Predefined Credential Type* → `airtableTokenApi`, so it appears in their credential dropdown.

**Why publishing fails before this:** n8n refuses to activate a workflow whose trigger has unresolved
issues, and a Gmail Trigger with no credential is exactly that. Nothing is wrong with the JSON.

**c. Import** both demo JSON files. **n8n 2.31 has no "Import from File" menu item** — that option is
gone from the workflow's *More actions* menu. Paste onto the canvas instead:

1. Workflows → **Create workflow** (opens a blank canvas).
2. Open the `.json` in any text editor, select all, copy.
3. Click an empty spot on the canvas, press **Ctrl+V**. The nodes and their wiring appear.
4. Rename the workflow (top-left) and **Publish/Save**.

Verified working on this instance 2026-07-29 by pasting a probe node.

## Step 3 — prove inbound

> **You do not need to Publish to run the manual test.** *Test workflow* executes whatever is on the
> canvas right now. Publishing (= save + activate) is only required for the **Gmail Trigger** to poll
> on its own, and n8n refuses to activate a workflow whose trigger has unresolved issues — a Gmail
> Trigger with no credential attached is exactly such an issue. So the order is: paste → set the
> secret → run the manual test → *then* attach the Gmail credential → *then* publish.

1. Open the inbound workflow and click **Test workflow**. The Manual trigger sends a synthetic
   message, exercising the real signing and HTTP path with no Gmail involved. Expect
   `statusCode: 200` and `{ "ok": true, ... }`.
2. Open the Gmail Trigger, attach the Gmail credential, **activate** the workflow.
3. Send any email to `mac@aequilibri`.
4. Verify: `/app/sunridge/integrations` shows the `email / in` row's "Last event" stamped, and a new
   document (plus any AI-drafted proposals) appears under Documents / Approvals.

## Step 4 — prove outbound

1. Make the platform emit an event for sunridge. Any of these enqueue a `PLAT_OUTBOX` row:
   - **approve any proposal** (`executeProposal` emits `<table>.<op>` — easiest to trigger),
   - mark a report sent (`report.ready`),
   - accept an assessment (`assessment.accepted`).
2. Check the control base: a `PLAT_OUTBOX` row with `Org_Slug=sunridge`, `Status=pending`.
   The Integrations page also lists it under "Recent outbound events".
3. Open the outbound workflow and click **Test workflow** (or activate it and wait up to 2 minutes).
4. Verify: the email arrives at `mac@aequilibri`, and the outbox row flips to `Status=delivered`
   with `Delivered_At` set.

The recipient is hardcoded to `mac@aequilibri.com` in the Gmail node — deliberately, for the demo.
It sidesteps the still-open "where does the destination come from" decision in the plan doc. Change
that field if your domain differs.

---

## Reading failures

The inbound HTTP node uses `fullResponse` + `neverError`, so a rejection is readable output rather
than a red node:

| Status | Meaning |
| --- | --- |
| 401 `Invalid signature` | The timestamp was fine; only the HMAC failed. **If a manual run passes but real emails fail, see "Manual works, real email 401s" below** — that is a different cause. Otherwise check the Crypto node's Secret field: it is a masked password input, so a leftover `PASTE_..._HERE` placeholder looks identical to a real secret. Diagnose with the script below. |
| 401 `Missing or stale timestamp` | Clock skew >300s, or the timestamp header didn't arrive. |
| 403 | No active `email / in` connection row for the org. |
| 404 | Unknown `orgSlug` — check the `ORG_SLUG` constant in the Code node. |
| 503 | No secret resolved for the org (neither per-org nor the `PLATFORM_WEBHOOK_SECRET` fallback). |

## Diagnosing an "Invalid signature" 401

[`scripts/verify-webhook-signature.mjs`](../scripts/verify-webhook-signature.mjs) recomputes the HMAC
locally and splits the two failure modes apart. Open the failed n8n execution → the
**Sign (HMAC-SHA256)** node → OUTPUT tab, copy `rawBody`, `ts` and `signature` into a JSON file, then:

```bash
AEQ_WEBHOOK_SECRET="<org secret>" node scripts/verify-webhook-signature.mjs sample.json
```

- **MISMATCH** → n8n signed with a different secret. Re-paste it into the Crypto node.
- **MATCH** → the secret is right, so the *body* changed between signing and sending. Check the HTTP
  node's Body Content Type is **RAW**, not JSON.

It also flags stray whitespace and non-canonical JSON, both of which are invisible in the n8n UI.

## Manual works, real email 401s

Reported 2026-07-29: **Execute workflow** succeeded every time, while every Gmail-triggered run
failed on the signature. That asymmetry is the diagnosis.

The manual trigger's synthetic message is pure ASCII, so its bytes are identical under *any*
character encoding — it cannot fail this way. A real email is not: smart quotes, em dashes,
non-breaking spaces, accented sender names and emoji are all multi-byte in UTF-8. The HMAC is
computed by the Crypto node over a JavaScript **string**, but the platform recomputes it from the
**bytes** it received (`await request.text()`). If anything re-encodes those bytes between the two,
the signature no longer matches — and only non-ASCII content can expose it.

**Fixed in the Code node** (both inbound workflows): `rawBody` now escapes every non-ASCII
codepoint as `\uXXXX`, so the string that gets signed is pure ASCII and survives any transit
encoding unchanged. This is not lossy — `\uXXXX` is valid JSON, and the platform's `JSON.parse`
restores the exact original characters, emoji and surrogate pairs included.

**If you already imported the old workflow, re-paste the Code node** — the fix is in the JSON, not
on the platform, so an existing n8n copy keeps the old behaviour until you update it.

Verified against a message carrying `“ ” — nbsp 🎉 👷‍♂️` and a `José Núñez` sender: rawBody is
ASCII-only, the HMAC holds under both UTF-8 and a deliberately wrong transit encoding, and subject,
body, sender and dedup id all round-trip byte-identical.

## Testing without n8n at all

[`scripts/send-test-webhook.mjs`](../scripts/send-test-webhook.mjs) sends the same signed payload
from your machine — useful for isolating whether a problem is in n8n or in the platform:

```bash
AEQ_WEBHOOK_SECRET="<secret from step 1a>" node scripts/send-test-webhook.mjs sunridge
```

## Duplicating inbound for another client

Change three things: the Gmail credential, the `ORG_SLUG` constant in the Code node, and the secret
in the Crypto node. See the plan doc for why this should eventually become a thin shell calling a
shared sub-workflow rather than a full copy per client.

## Known instance limitations (2026-07-29)

The signed-in account (`mac.antonio…`) is a **member**, not the instance owner, on
`aequilibri.app.n8n.cloud`. Confirmed by `/settings/users` redirecting away and the Settings menu
lacking Users / Usage and plan. Consequences:

- **Cannot create *Global* Variables** — hence the pasted-secret approach above. Note the sidebar
  **＋ → New variable** menu offers a "Create in: Global / **Personal**" choice, so a *Personal*-scoped
  variable may still be creatable on a member account. Worth a try if you'd rather reference
  `$vars.AEQ_SECRET_SUNRIDGE` than paste the literal — but the pasted secret works today either way.
- **Cannot see the plan tier or the active-workflow cap** — that cap is the ceiling on the
  one-workflow-per-client design, so it needs answering before rollout.
- **No team projects exist** (only "Personal" and "Shared with you"), so every client's workflow and
  Gmail credential would land in one individual's personal space. Fine for a demo; not for rollout.

Worth getting owner access, or an owner to set up per-client projects, before going past this demo.
