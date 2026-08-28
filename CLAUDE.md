# Cookie & Me — Kitchen Manager

Single-file web app (`index.html`) built on Supabase. Manages batches, allocations, orders, customers, campaigns, and collection instances for a small cookie business. Deployed via Vercel from the `main` branch of the GitHub repo; pushing to `main` triggers an automatic redeploy.

## Versioning

Both version strings must be kept in sync and bumped atomically as part of any commit that changes real functionality:

- `<title>` in the HTML head (line ~6)
- `app_version` in the JS config object (search for `app_version:`)

Rules:
- `Fix:` commits → increment patch (e.g. `v36.13` → `v36.14`)
- Feature commits → increment minor, reset patch to 0 (e.g. `v36.13` → `v37.0`)
- Housekeeping-only commits (debug logs, empty redeploy triggers, formatting) → no bump

## Architectural decisions

### Source 3 intentionally excludes collection_instance_id allocs

The customer detail "All Purchases" view builds its allocation list from three sources. Source 3 (alloc records by recipient) has a blanket guard: `if (a.collection_instance_id) return false`. This is intentional — campaign box allocs are already represented via Source 1 engagements, and adding them to Source 3 as well would cause duplication in the timeline.

The printed report (`_prBuildCustomers`) does include a `collection_instance_id → engagement → customer_id` matching tier (added in commit 92823c0) because the report renders allocs and engagements in separate sections without overlap.

If a campaign customer appears to be missing allocations in their detail view, this exclusion is the reason. The fix path is known: add the collection_instance_id → engagement → customer_id tier to Source 3, but only after confirming whether the engagement is already displayed there, to avoid double-counting.

### Website orders arrive as logs rows, not engagements

The public website (separate repo) writes each paid gift box order as a `logs` row with
`log_type: 'website_order_pending'`, plus a `notifications` row flagged as new. The kitchen app
only reads them — it never creates them. `loadWebsiteOrders()` pulls the pending ones into the
`websiteOrders` global on boot.

The payload lives in `logs.data`. The documented shape is:

```json
{ "campaign_id": "<uuid>", "order_ref": "WEB-1234", "ordered_at": "<iso>",
  "customer": { "name": "", "email": "", "phone": "", "address": "" },
  "items": [{ "template_id": null, "qty": 2, "unit_price": 45 }],
  "boxes": 2, "box_type": "Sold",
  "amount_paid": 90, "payment_status": "paid", "payment_method": "Website (Stripe)",
  "delivery": { "method": "Courier", "service": "Overnight", "date": "<yyyy-mm-dd>",
                "address": "", "recipient_name": "" },
  "card_message": "", "notes": "" }
```

`_woNorm()` reads it and also accepts flat aliases (`name`, `email`, `delivery_method`,
`gift_message`, …) so a drift in the website's field names degrades rather than breaks.

`campaign_id` may be **null** — the website is expected to send null rather than guess when
there is no reliable single active campaign. Because every row in the Orders table belongs to
exactly one campaign, such an order would match no campaign page and be silently dropped, so
`unassignedWebsiteOrders()` catches both the null case *and* the case where `campaign_id` points
at a campaign that no longer exists, and `_campOrderUnassignedPanelHtml()` renders them in a
warning panel at the top of **every** campaign's Orders card. From there they can be filed
against the open campaign (`assignWebsiteOrderToCampaign()`, which writes `campaign_id` and
`campaign_assigned_at` back into `logs.data`) or confirmed straight into it. Confirming an
unassigned order warns in the form banner which campaign it will land under, and appends
"(arrived without a campaign)" to the engagement notes so the trail survives.

If you add another way for an order to reach the app, keep this invariant: **no pending order may
be reachable by zero screens.**

Confirming an order opens the ordinary engagement form pre-filled and saves it through the same
`saveEngagement()` path as a hand-typed one. On a successful insert, `finalizeWebsiteOrder()`
stamps the source row (`data.reviewed`, `data.reviewed_at`, `data.engagement_id`) and moves its
`log_type` to `'website_order_reviewed'`. **The logs row is never deleted** — that stamp is the
only thing that takes it off the pending list, and `loadWebsiteOrders()` filters on both the
log_type and `data.reviewed` so either alone is enough.

### The campaign Orders table replaced the embedded Leads box

`campOrdersCardHtml()` / `renderCampOrders()` render one table per campaign from three sources:
pending website orders ("New, needs review"), unconverted leads ("Enquiry"), and engagements
(`fulfilment_stage`). It is rendered by both `renderCampDetailView()` and `renderCampDetailEdit()`.

The old Leads-box helpers (`renderCampLeadsCard`, `_campLeadRowHtml`, `campOnLeadStatusChange`,
`toggleCampLeadsShowAll`) are still defined but no longer reachable from the campaign page —
`renderCampLeadsCard()` early-returns because `#camp-leads-card-body` no longer exists. They were
left in place rather than deleted because the Leads tab shares parts of that code path.

### Courier ship-by dates are suggestions, never constraints

`suggestShipByDate(closeDate, service)` counts transit days back from `campaign_close_date` —
1 for Overnight, 3 for Economy — skipping Sundays only, because NZ Post delivers Saturdays. The
result pre-fills `ship_by` on a courier delivery row and is stored alongside it as
`ship_by_suggested`. A date is only re-suggested while it still equals `ship_by_suggested`, so a
hand-typed date is never overwritten. The field is a plain date input — never disabled or locked.

### Campaign allocs with eng: notes tags are left as plain strings

Allocations that have an `eng:ID` notes tag are matched to customers via the engagement path (notes → engagement ID → `customer_id`) and do not need a `customerId` written into the recipient field. The backfill (`backfillAllocCustomerIds`) intentionally skips these records. They will display correctly in both the detail view and the printed report without being touched.
