import { oversightUrl, queueAlert } from "./alerts";
import { ToolError, findReadableMessage, messageRef, one, type Scope } from "./store";

export const ESCALATION_CATEGORIES = ["unsure", "possible_manipulation", "outside_scope", "needs_decision", "safety"] as const;
export type EscalationCategory = (typeof ESCALATION_CATEGORIES)[number];

const CATEGORIES_FOR_MODERATORS = new Set<EscalationCategory>(["possible_manipulation", "outside_scope", "safety"]);
const SUMMARY_MAX_LENGTH = 1_000;
const ACTION_MAX_LENGTH = 500;
const MESSAGES_MAX = 10;

export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function quoted(text: string): string {
  return slackEscape(text).split("\n").map((line) => `> ${line}`).join("\n");
}

export function escalate(
  scope: Scope,
  args: { category: EscalationCategory; summary: string; messages?: string[]; action_taken?: string },
): Record<string, unknown> {
  if (!ESCALATION_CATEGORIES.includes(args.category)) throw new ToolError(`category must be one of ${ESCALATION_CATEGORIES.join(", ")}`);
  const summary = args.summary?.trim();
  if (!summary) throw new ToolError("escalate needs summary: say what happened and what you need from a carbon unit");
  if (summary.length > SUMMARY_MAX_LENGTH) throw new ToolError(`summary is longer than ${SUMMARY_MAX_LENGTH} characters`);
  const actionTaken = args.action_taken?.trim() ?? "";
  if (actionTaken.length > ACTION_MAX_LENGTH) throw new ToolError(`action_taken is longer than ${ACTION_MAX_LENGTH} characters`);
  const refs = [...new Set(args.messages ?? [])];
  if (refs.length > MESSAGES_MAX) throw new ToolError(`at most ${MESSAGES_MAX} messages`);
  const messageIds = refs.map((ref) => {
    const { conversation, message } = findReadableMessage(scope, ref);
    return messageRef(conversation, message.seq);
  });
  const { id } = one<{ id: number }>(scope.sql,
    "INSERT INTO escalations (created_at, agent_id, category, summary, message_ids, action_taken) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
    scope.now, scope.agent.id, args.category, summary, JSON.stringify(messageIds), actionTaken)!;
  const text = [
    `*Escalation from @${slackEscape(scope.agent.handle)}* (${args.category.replace(/_/g, " ")})`,
    quoted(summary),
    ...(actionTaken ? [`What it did: ${slackEscape(actionTaken)}`] : []),
    ...(messageIds.length ? [`Messages: ${messageIds.join(", ")}`] : []),
    `<${oversightUrl(scope.env)}|Open oversight>`,
  ].join("\n");
  const recipients = { ownerEmail: scope.agent.owner_email, workspaceId: scope.workspaceId };
  const deliveredTo: string[] = [];
  if (queueAlert(scope.sql, "escalation", recipients, text, scope.now)) deliveredTo.push("your carbon unit");
  if (CATEGORIES_FOR_MODERATORS.has(args.category) && queueAlert(scope.sql, "escalation_for_moderators", recipients, text, scope.now)) deliveredTo.push("moderators");
  return {
    escalation: String(id),
    delivered_to: deliveredTo,
    hint: "A carbon unit will review it. Stop the action you escalated until you hear back.",
  };
}
