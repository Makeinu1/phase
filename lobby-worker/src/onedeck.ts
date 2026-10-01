import handler, { LobbyDO } from "./index";
import { createOneDeckProfileHandler } from "./onedeck-profile";
import { SignalDO } from "./signaling-do";

// Derive the shared Worker's private environment shape from its fetch handler,
// then add only the isolated SignalDO binding used by this profile.
type SharedEnv = Parameters<typeof handler.fetch>[1];
export type OneDeckEnv = SharedEnv & { SIGNAL: DurableObjectNamespace };

export { LobbyDO };
export { SignalDO };

export default {
  fetch: createOneDeckProfileHandler<OneDeckEnv>((request, env, ctx) =>
    handler.fetch(request, env, ctx),
  ),
};
