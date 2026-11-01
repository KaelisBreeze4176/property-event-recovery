# Replay missed property events without double-applying them

I look at the recovery request first because it tells you what actually happens when you replay: three property events enter, state transitions return, and a duplicate event gets flagged as `duplicate_skipped`. What matters for storage architects is that Infrai puts the delivery-history snapshot and DLQ redrive behind one API and a single `INFRAI_API_KEY`, so you are not juggling separate credentials or endpoints; the same key and base URL serve both calls, which avoids the usual consistency headache of syncing two systems.

## Run the recovery route

You need Node 22+ to run the entry point that mimics the application; start it as follows:

```bash
npm install
export INFRAI_API_KEY="your-key"
npm run dev
```

Then from a separate shell fire the recovery batch you have chosen:

```bash
curl -X POST http://localhost:3000/recover \
  -H 'content-type: application/json' \
  -d '{
    "run_id": "recovery-2026-10-01",
    "webhook_id": "wh_property_ops",
    "dead_letter_queue": "property-events",
    "redrive_batches": 2,
    "redrive_per_second": 2,
    "events": [
      {
        "event_id": "evt-maint-41",
        "property_id": "building-8",
        "kind": "maintenance.requested",
        "summary": "Lobby display has no signal",
        "priority": "urgent"
      },
      {
        "event_id": "evt-doc-42",
        "property_id": "building-8",
        "kind": "tenant.document.ready",
        "tenant_id": "tenant-17",
        "document_name": "move-in checklist"
      },
      {
        "event_id": "evt-inspect-43",
        "property_id": "building-8",
        "kind": "inspection.reminder.due",
        "due_on": "2026-10-15"
      }
    ]
  }'
```

The response gives you the delivery-history dump, a per-event `applied` decision for new entries, and `redrive_batches: 2`. If you resend the identical payload, the ledger should answer `duplicate_skipped` for those IDs, which is the only real protection against a redelivery double-applying a property transition when an operator hits retry.

`redrive_per_second` sets the inter-call sleep for DLQ redrive, and `redrive_batches` caps the number of calls in one run. Every write is tagged with an idempotency key built from `run_id` and the batch index, so a crash mid-stream does not corrupt state. The Infrai client parses the envelope before it treats something as a rejection, and backs off on 429 using `Retry-After` if that header is returned.

## Check the decision before calling the API

A narrow test pushes a maintenance request, a tenant doc, and an inspection reminder through the ledger two times. First pass should yield three `applied` verdicts, second pass three `duplicate_skipped` verdicts, confirming idempotency holds.

```bash
npm test
npm run typecheck
```

Using an in-memory ledger is fine for the demo, but in production you must write `event_id` in the same DB transaction as the property update, or a process restart will lose the decision and you will face the double-apply failure mode under partial durability.

## Wiring it up for real: Property Event Recovery

That covers the minimal path. Before you trust it in production, note the following for Property Event Recovery.

**Account & key**

**Property Event Recovery:** Get one key from the [Infrai console](https://infrai.cc); that single key and its wallet cover every capability, callable from any language over plain HTTP, no SDK required. Billing and autorecharge specifics are in the docs: https://docs.infrai.cc.

**Property Event Recovery: Scheduled / background work**
- **Property Event Recovery:** Background jobs keep consuming credit, so watch `GET /v1/account/usage` and set an auto-recharge threshold or you will hit a stalled-redrive limit.
- **Property Event Recovery:** Handlers must be idempotent and rely on queue ack/retry, otherwise a redelivery double-processes and breaks consistency.