import { z } from "zod";

const commonEvent = {
  event_id: z.string().min(1),
  property_id: z.string().min(1),
};

export const recoveryRequestSchema = z.object({
  run_id: z.string().min(1),
  webhook_id: z.string().min(1),
  dead_letter_queue: z.string().min(1),
  redrive_batches: z.number().int().min(1).max(20).default(1),
  redrive_per_second: z.number().positive().max(10).default(2),
  events: z.array(z.discriminatedUnion("kind", [
    z.object({
      ...commonEvent,
      kind: z.literal("maintenance.requested"),
      summary: z.string().min(1),
      priority: z.enum(["routine", "urgent"]),
    }),
    z.object({
      ...commonEvent,
      kind: z.literal("tenant.document.ready"),
      tenant_id: z.string().min(1),
      document_name: z.string().min(1),
    }),
    z.object({
      ...commonEvent,
      kind: z.literal("inspection.reminder.due"),
      due_on: z.iso.date(),
    }),
  ])).min(1),
});

export type RecoveryRequest = z.infer<typeof recoveryRequestSchema>;
export type PropertyEvent = RecoveryRequest["events"][number];

export type ReplayDecision = {
  event_id: string;
  status: "applied" | "duplicate_skipped";
  result: string;
};

function resultFor(event: PropertyEvent): string {
  switch (event.kind) {
    case "maintenance.requested":
      return `${event.priority} maintenance opened for ${event.property_id}: ${event.summary}`;
    case "tenant.document.ready":
      return `${event.document_name} attached to tenant ${event.tenant_id}`;
    case "inspection.reminder.due":
      return `inspection reminder scheduled for ${event.property_id} on ${event.due_on}`;
  }
}

export class PropertyReplayLedger {
  private readonly appliedEventIds = new Set<string>();

  apply(events: PropertyEvent[]): ReplayDecision[] {
    return events.map((event) => {
      if (this.appliedEventIds.has(event.event_id)) {
        return {
          event_id: event.event_id,
          status: "duplicate_skipped",
          result: "existing property state kept",
        };
      }
      this.appliedEventIds.add(event.event_id);
      return { event_id: event.event_id, status: "applied", result: resultFor(event) };
    });
  }
}
