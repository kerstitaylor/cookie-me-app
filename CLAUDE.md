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

### Campaign allocs with eng: notes tags are left as plain strings

Allocations that have an `eng:ID` notes tag are matched to customers via the engagement path (notes → engagement ID → `customer_id`) and do not need a `customerId` written into the recipient field. The backfill (`backfillAllocCustomerIds`) intentionally skips these records. They will display correctly in both the detail view and the printed report without being touched.
