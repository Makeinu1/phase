import { createContext } from "react";

import type { ObjectId } from "../../adapter/types.ts";

/**
 * Offers "perform by hand" on a stack object the engine says its viewer may
 * designate for manual resolution (a spell, or an activated or triggered
 * ability the viewer controls). The engine's interaction choices are the only
 * authority on which entries qualify; the stack only shows the offer.
 */
export interface ManualDesignation {
  readonly canDesignate: (stackEntryId: ObjectId) => boolean;
  readonly designate: (stackEntryId: ObjectId) => void;
  readonly busy: boolean;
}

export const ManualDesignationContext = createContext<ManualDesignation | null>(null);
