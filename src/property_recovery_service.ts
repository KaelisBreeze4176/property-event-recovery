import { createServer } from "node:http";
import { InfraiControlPlane, InfraiError, infraiBaseUrl } from "./infrai_control_plane.js";
import { PropertyReplayLedger, recoveryRequestSchema } from "./replay_planner.js";

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

const port = Number(process.env.PORT ?? 3000);
const infrai = new InfraiControlPlane(apiKey, infraiBaseUrl);
const ledger = new PropertyReplayLedger();

function send(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/recover") {
    send(response, 404, { error: "POST /recover is the available route" });
    return;
  }

  try {
    const parsed = recoveryRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      send(response, 400, { error: "Invalid recovery request", issues: parsed.error.issues });
      return;
    }

    const input = parsed.data;
    const history = await infrai.deliveryHistory(input.webhook_id);
    const decisions = ledger.apply(input.events);
    const redrives: unknown[] = [];
    const interval = 1_000 / input.redrive_per_second;

    for (let index = 0; index < input.redrive_batches; index += 1) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, interval));
      redrives.push(await infrai.redriveDeadLetters(
        input.dead_letter_queue,
        `${input.run_id}:redrive:${index}`,
      ));
    }

    send(response, 200, {
      run_id: input.run_id,
      history,
      decisions,
      redrive_batches: redrives.length,
    });
  } catch (error) {
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      send(response, status, { error: error.message, details: error.details });
      return;
    }
    send(response, 400, { error: error instanceof Error ? error.message : "Invalid request" });
  }
});

server.listen(port, () => {
  console.log(`Property recovery service listening on http://localhost:${port}`);
});
