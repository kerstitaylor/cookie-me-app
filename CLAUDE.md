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

### The freezer is a hold, not a route — `sumConsumedQty()`

Cookies put in the freezer are on hold. They consume their batch's yield so nothing else can
be allocated from them, and they cannot be iced or allocated while they sit there. Taking them
out returns them to the batch's ordinary unallocated pile **as though they had never been
frozen** — from that point they are iced and allocated exactly like any other cookie, with no
special treatment anywhere in the app. The freezer is a side quest between baking and whatever
comes next, and the only residue is a tag showing how long the stint lasted.

Two child row types record what became of a lot, both carrying `frozen_source_id`:

| type | meaning | batch accounting |
|---|---|---|
| `unfrozen` | went back into the pile | **subtracted** — the cookies are available again |
| `disposal` | binned while frozen | left counted — those cookies really did leave the batch |

The parent `frozen` row's `qty` is what went in and never changes, so the freeze stays on the
record. A lot's held quantity is `qty_frozen − returned − written_off`.

`sumConsumedQty(rows)` implements exactly that, and every per-batch qty total goes through it
(~24 sites: the allocation guard, tally, remaining prefill, unallocated banner, batch history
cards, campaign batch cards, stocktake, CSV, the printed batch report and the reconciliation
report). Listings are deliberately left alone — a freezer row is a real allocation and must stay
visible; only the *totals* apply the rule. The two accountability blocks compare a rendered-list
total against a database total, so both sides carry a parallel `cq` accumulator and their
mismatch warnings keep working.

Because a released cookie takes the ordinary path, **nothing downstream needs to know about the
freezer**. An earlier design routed frozen cookies to customers directly and would have
double-counted them through `usedOrders` once they were iced and sold; the hold model removes
that failure mode entirely rather than patching it.

`cost_to_make` needs no special handling: cost aggregations filter on
`type in ('sold','customer')` plus `order_ids`/`campaign_ids`, so `frozen` and `unfrozen` rows
are already excluded, and the eventual real allocation carries the cost as normal.

`fetchLiveBatchAllocations(batchNum)` centralises the live guard query. It filters
`deleted_at IS NULL` (a soft-deleted allocation used to keep consuming batch capacity — a real
bug from the soft-delete work) and returns `null` on error, which callers must treat as "cannot
verify" and refuse rather than as "nothing allocated".

### Frozen stock screen

`allocations.frozen_use_by` (date) is set only on `type='frozen'` rows; `frozen_source_id`
(self-FK) is set on the `unfrozen` and `disposal` children. The `frozen_lots` view rolls each lot
up with `qty_returned` / `qty_written_off` / `qty_held`.

The screen (Production → ❄️ Frozen) **does not query that view**. `frozenLots()` mirrors it in JS
from the in-memory `allocs` global — which already excludes soft-deleted rows, matching the
view's `deleted_at` filters — so the screen stays in step after an insert without a round trip.
The view remains the reference definition; if you change one, change both. A test confirmed the
two agree exactly (156 put in / 106 held / 50 taken out).

Use-by defaults to freeze date + `FROZEN_SHELF_LIFE_WEEKS` (12) and is always editable; a lot
within `FROZEN_EXPIRY_WARN_DAYS` (7) of it is highlighted. Emptied lots are hidden behind a
toggle and never deleted, for traceability. Guards: a lot with any children cannot be deleted,
and its qty cannot be edited below what has already left it.

### Source 3 intentionally excludes collection_instance_id allocs

The customer detail "All Purchases" view builds its allocation list from three sources. Source 3 (alloc records by recipient) has a blanket guard: `if (a.collection_instance_id) return false`. This is intentional — campaign box allocs are already represented via Source 1 engagements, and adding them to Source 3 as well would cause duplication in the timeline.

The printed report (`_prBuildCustomers`) does include a `collection_instance_id → engagement → customer_id` matching tier (added in commit 92823c0) because the report renders allocs and engagements in separate sections without overlap.

If a campaign customer appears to be missing allocations in their detail view, this exclusion is the reason. The fix path is known: add the collection_instance_id → engagement → customer_id tier to Source 3, but only after confirming whether the engagement is already displayed there, to avoid double-counting.

### Website orders arrive as logs rows, not engagements

The public website (separate repo) writes each paid gift box order as a `logs` row with
`log_type: 'website_order_pending'`, plus a `notifications` row flagged as new. The kitchen app
only reads them — it never creates them. `loadWebsiteOrders()` pulls the pending ones into the
`websiteOrders` global on boot.

The payload lives in `logs.data`. The real shape, as observed on live orders, is flat and
camelCase — **not** the nested `customer`/`delivery` shape this file used to describe:

```json
{ "name": "", "email": "", "phone": "", "address": "",
  "boxCount": 1, "packs": [{ "qty": 1, "packSize": 6 }], "items": "1 × 6 Pack",
  "amountPaid": 20, "shippingFee": 0, "paid": true,
  "deliveryMethod": "delivery | huttDelivery | ...", "deliveryLabel": "",
  "toCollectionPoint": false,
  "occasion": "Father's Day", "theme": "Father's Day", "flavour": null,
  "cardMessage": "", "orderedAt": "<iso>", "source": "website",
  "campaignId": null, "campaign_id": null,
  "stripeSessionId": "cs_live_..." }
```

`_woNorm()` reads this first and keeps the nested/snake_case aliases as fallbacks, so either
form works. Getting this wrong is not loud: an unread key silently becomes a default, and for a
while `cardMessage`, `amountPaid`, `deliveryMethod` and `address` were all being dropped — orders
landed as "Collect", unpaid, with no gift message. If the website changes a key, check
`_woNorm()` against a real `logs.data` row rather than trusting this block.

`campaign_id` may be **null** — the website is expected to send null rather than guess when
there is no reliable single active campaign. Because every row in the Orders table belongs to
exactly one campaign, such an order would match no campaign page and be silently dropped, so
`unassignedWebsiteOrders()` catches both the null case *and* the case where `campaign_id` points
at a campaign that no longer exists, and `_campOrderUnassignedPanelHtml()` renders them in a
warning panel at the top of **every** campaign's Orders card. From there they can be filed
against the open campaign (`assignWebsiteOrderToCampaign()`, which writes `campaign_id` and
`campaign_assigned_at` back into `logs.data`) or confirmed straight into it.

### One checkout, one engagement — `source_order_key`

`campaign_engagements.source_order_key` holds `stripe:<session id>` (falling back to
`log:<logs row id>`) and is written **in the same insert that creates the engagement**, so the
link to the source checkout exists the moment the engagement does. A partial unique index,
`campaign_engagements_source_order_key_live` (`where source_order_key is not null and
deleted_at is null`), means the database itself refuses a second live engagement for the same
checkout; `_doSaveEngagement()` catches the 23505 and explains it.

This replaced a fragile arrangement where "already confirmed" was recorded only by stamping the
logs row *after* the insert. That stamp is a second write, it failed once in production, and the
order sat pending for 36 hours until it was confirmed a second time — producing duplicate
engagements *and* duplicate customer records. `pendingWebsiteOrders()` now derives what is still
outstanding from `source_order_key` on live engagements, so a missed stamp can no longer
resurrect an order. The logs stamp is still written, but it is now best-effort belt-and-braces.

**The key is always the individual checkout, never the customer.** Two genuine orders from the
same person — same name, email, phone, identical contents, same day — must both come through.
Never dedupe website orders on customer identity or order contents.

If you add another way for an order to reach the appIf you add another way for an order to reach the app, keep this invariant: **no pending order may
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

### Deleting an order is always confirm → soft delete → undo

`softDeleteEngagement()` is the standing pattern for removing an order, and the only delete
reachable from the UI (`confirmDeleteEng()` is now just an alias for it — the old hard delete on
the campaign edit screen is gone). It always: asks via `showConfirm()` saying the delete can be
undone, stamps `deleted_at` rather than removing anything, and then offers `showDeleteToast()`
with a live undo. Soft-deleted orders also stay restorable from the "Show N deleted orders"
strip under the campaign Orders table, so an expired toast never loses them.

Engagements use a `deleted_at` flag rather than the app's snapshot trash
(`softDelete()` → `deleted_records`) deliberately. Three things reference an engagement by id —
allocation records tagged `eng:<id>` in `notes`, `logs.data.engagement_id` on a confirmed website
order, and `leads.engagement_id` — and `deleted_records.record_id` is a `bigint` that cannot even
hold an engagement's uuid. Snapshot-and-reinsert would bring the row back under a *new* id and
leave all three pointing at nothing: visually restored, actually broken.

Allocations tied to the engagement are hidden with it (`allocations.deleted_at`) and restored
with it, so a deleted order stops consuming batch yield and collection stock. Both writes are
all-or-nothing: if any allocation fails to hide, the engagement is un-deleted rather than left
half-deleted with its stock still committed.

`campEngagements` and `allocs` are filtered at their **loaders**, not at each call site. Both are
read in dozens of places (campaign views, customer detail, printed reports, financials, box
fulfilment, customer sync); splitting `deletedEngagements` / `deletedAllocs` off once at load
means every consumer excludes deleted rows without having to be found and changed.

### Courier ship-by dates are suggestions, never constraints

`suggestShipByDate(closeDate, service)` counts transit days back from `campaign_close_date` —
1 for Overnight, 3 for Economy — skipping Sundays only, because NZ Post delivers Saturdays. The
result pre-fills `ship_by` on a courier delivery row and is stored alongside it as
`ship_by_suggested`. A date is only re-suggested while it still equals `ship_by_suggested`, so a
hand-typed date is never overwritten. The field is a plain date input — never disabled or locked.

### Campaign allocs with eng: notes tags are left as plain strings

Allocations that have an `eng:ID` notes tag are matched to customers via the engagement path (notes → engagement ID → `customer_id`) and do not need a `customerId` written into the recipient field. The backfill (`backfillAllocCustomerIds`) intentionally skips these records. They will display correctly in both the detail view and the printed report without being touched.
