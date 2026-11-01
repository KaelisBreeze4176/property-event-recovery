import assert from "node:assert/strict";
import test from "node:test";
import { PropertyReplayLedger, recoveryRequestSchema } from "../src/replay_planner.js";

test("applies each property event once when a recovery batch is retried", () => {
  const request = recoveryRequestSchema.parse({
    run_id: "recovery-2026-10-01",
    webhook_id: "wh_property_ops",
    dead_letter_queue: "property-events",
    redrive_batches: 1,
    redrive_per_second: 2,
    events: [
      {
        event_id: "evt-maint-41",
        property_id: "building-8",
        kind: "maintenance.requested",
        summary: "Lobby display has no signal",
        priority: "urgent",
      },
      {
        event_id: "evt-doc-42",
        property_id: "building-8",
        kind: "tenant.document.ready",
        tenant_id: "tenant-17",
        document_name: "move-in checklist",
      },
      {
        event_id: "evt-inspect-43",
        property_id: "building-8",
        kind: "inspection.reminder.due",
        due_on: "2026-10-15",
      },
    ],
  });
  const ledger = new PropertyReplayLedger();

  const first = ledger.apply(request.events);
  const retry = ledger.apply(request.events);

  assert.deepEqual(first.map((decision) => decision.status), ["applied", "applied", "applied"]);
  assert.deepEqual(retry.map((decision) => decision.status), [
    "duplicate_skipped",
    "duplicate_skipped",
    "duplicate_skipped",
  ]);
  assert.match(first[0]!.result, /Lobby display has no signal/);
});
