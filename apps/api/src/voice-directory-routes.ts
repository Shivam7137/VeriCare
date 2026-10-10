import type { FastifyInstance } from "fastify";
import {
  careTeamQuerySchema,
  simulatedTransferResultInputSchema,
  voiceTransferInputSchema,
} from "@prc/contracts";
import { BackendError } from "./domain.js";
import type { Principal } from "./identity.js";
import type { CareTeamDirectory } from "./care-team-directory.js";
import type { VoiceTransfers } from "./voice-transfers.js";
import type { VoiceStore } from "./voice-store.js";

export function registerVoiceDirectoryRoutes(
  api: FastifyInstance,
  directory: CareTeamDirectory,
  transfers: VoiceTransfers,
  store: VoiceStore,
  actor: (request: object) => Principal,
) {
  api.get("/voice/directory", async (request) => {
    const query = request.query as Record<string, unknown>;
    const doctor =
      query.doctor === undefined
        ? undefined
        : query.doctor === "true"
          ? true
          : query.doctor === "false"
            ? false
            : query.doctor;
    return directory.list(
      actor(request),
      careTeamQuerySchema.parse({ ...query, ...(doctor === undefined ? {} : { doctor }) }),
    );
  });
  api.patch<{ Params: { id: string } }>("/voice/directory/:id", (request) =>
    directory.update(actor(request), request.params.id, request.body),
  );
  api.get<{ Params: { id: string } }>("/voice/calls/:id/transfers", (request) =>
    transfers.list(actor(request), request.params.id),
  );
  api.post<{ Params: { id: string } }>("/voice/calls/:id/transfers", async (request, reply) => {
    const call = await store.get(actor(request), request.params.id);
    if (call.actorId !== actor(request).id) throw new BackendError("forbidden", 403);
    return reply
      .code(201)
      .send(await transfers.prepare(call.id, voiceTransferInputSchema.parse(request.body)));
  });
  api.post<{ Params: { id: string } }>("/voice/transfers/:id/simulate-result", async (request) =>
    transfers.simulateResult(
      actor(request),
      request.params.id,
      simulatedTransferResultInputSchema.parse(request.body).status,
    ),
  );
}
