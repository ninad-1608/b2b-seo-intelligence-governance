"use client";

import { createContext, useContext } from "react";
import type { Intent } from "./ContentBriefPanel";

/**
 * A request to open a tool workspace, optionally pre-filled. The opportunities table is rendered on the server and passed to
 * the dashboard as children, so it cannot receive callbacks as props; it reaches the dashboard through this context instead.
 */
export type ToolRequest =
  | { tool: "brief"; keyword: string; audience: string; intent: Intent; opportunityId?: number } // opens and generates automatically; with an opportunityId the server requires a human approval first
  | { tool: "refresh"; keyword: string; url?: string }
  | { tool: "decay" }
  | { tool: "crawler"; url?: string }
  | { tool: "sync" } // opens the Google connection dialog rather than a module
  | { tool: "geo"; queries: string } // GEO & LLM audit with the target query filled in
  | { tool: "clusters"; seedTopic: string }
  | { tool: "simulator"; query: string }
  | { tool: "cannibalization" };

type ToolActions = { openTool: (request: ToolRequest) => void };

const ToolActionsContext = createContext<ToolActions>({ openTool: () => {} });

export const ToolActionsProvider = ToolActionsContext.Provider;

export function useToolActions(): ToolActions {
  return useContext(ToolActionsContext);
}

/** Fired by the attention strip; the opportunity table opens that row's review. */
export const OPEN_OPPORTUNITY_EVENT = "seo:open-opportunity";
/** Fired after a reviewer decision, baseline lock or completion, so the attention strip reloads. */
export const REVIEW_CHANGED_EVENT = "seo:review-changed";
