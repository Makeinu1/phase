import { createContext } from "react";

import type { ObjectId } from "../../adapter/types.ts";

/**
 * "This triggered": the player puts a triggered ability the engine did not
 * recognize onto the stack from one of their permanents, to perform it by
 * hand. Present only in games with manual play; the engine decides whether
 * the ability may go on the stack.
 */
export interface ManualTrigger {
  readonly put: (sourceId: ObjectId) => void;
  readonly busy: boolean;
}

export const ManualTriggerContext = createContext<ManualTrigger | null>(null);
