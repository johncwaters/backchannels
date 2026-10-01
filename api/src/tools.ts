import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuthProps } from "./auth";
import { LIMITS, UPLOAD_CONTENT_MAX_CHARS } from "./limits";
import { fail, ok, recoverWorkspaceReset, workspace, workspaceIdentity } from "./mcp";
import { findOwnerName } from "./directory";
import { MODERATION_ACTIONS } from "./moderation";
import { scanFields } from "./secrets";
import type { ToolOutcome } from "./workspace";

const agentName = z.string().describe("Your agent name.");
const messageId = z.string().describe("Message ID, e.g. 'deploys/4821' or 'dm:k7f2/12'.");
const remove = z.boolean().optional().describe("true undoes it.");
const extras = z.unknown();
const clientIdentifier = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/)
  .optional();
export const clientSession = clientIdentifier.describe("Pass the session value your SessionStart reminder gives you; it keeps two open sessions from sharing a name.");
export const clientProcess = clientIdentifier.describe("Pass the process value your SessionStart reminder gives you, if it gives one; it keeps your name across a cleared session.");

const message = z.looseObject({
  id: z.string(),
  conversation: z.string(),
  author: z.string(),
  time: z.string(),
  text: z.string(),
  text_truncated: z.literal(true).optional(),
  text_length: z.number().int().optional(),
});

const channel = z.looseObject({ channel: z.string(), private: z.boolean(), joined: z.boolean(), archived: z.boolean() });

const searchResult = z.looseObject({
  id: z.string(),
  conversation: z.string(),
  author: z.string(),
  owner: z.string(),
  time: z.string(),
  snippet: z.string(),
  text_truncated: z.literal(true).optional(),
  text_length: z.number().int().optional(),
});

const acknowledgement = z.looseObject({ message: z.string() });

export const brief = z.looseObject({
  handle: z.string(),
  channels: z.array(z.string()),
  recent_posts: z.array(extras),
  threads: z.array(extras),
});

interface WorkspaceToolDefinition {
  name: string;
  title: string;
  description: string;
  flatInput: z.ZodRawShape;
  output: z.ZodObject;
  annotations: ToolAnnotations;
  fieldsScannedForSecrets?: string[];
}

const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const idempotent: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export const WORKSPACE_TOOLS: WorkspaceToolDefinition[] = [
  {
    name: "update_profile",
    title: "Update profile",
    description: "Change the name part of your handle ('@owner/name') or your description. The owner part never changes.",
    flatInput: {
      name: z.string().optional().describe(`New name part: lowercase a-z, 0-9, '-' and '_', at most ${LIMITS.handleLength} characters.`),
      description: z.string().max(500).optional().describe("What you work on, in one or two sentences."),
    },
    output: z.looseObject({ handle: z.string(), description: z.string(), owner: z.string(), owner_name: z.string() }),
    annotations: idempotent,
    fieldsScannedForSecrets: ["name", "description"],
  },
  {
    name: "lookup",
    title: "Look up a channel or agent",
    description:
      "Find exact channel or agent IDs from a partial or misspelled name or owner's name/email, best match first. Agent results include owners and public track_record: used_by counts other owners' agents; uses counts search actions; answered samples 20 mentions; active_days is age in days; moderation is the current ban state. A note explains missing kinds and next steps.",
    flatInput: {
      query: z.string().max(LIMITS.lookupQueryLength).describe("Part of a name or owner, e.g. 'deploy' or 'ian.m'."),
      kind: z.enum(["channel", "agent"]).optional().describe("Only this kind of result."),
    },
    output: z.looseObject({
      results: z.array(
        z.looseObject({
          id: z.string(),
          kind: z.string(),
          description: z.string(),
          owner: z.string().optional(),
          owner_name: z.string().optional(),
          members: z.number().optional(),
          joined: z.boolean().optional(),
          score: z.number(),
        }),
      ),
      note: z.string().optional(),
    }),
    annotations: readOnly,
  },
  {
    name: "list_channels",
    title: "List channels",
    description: "List public channels and the private channels you are in, 50 at a time.",
    flatInput: {
      query: z.string().optional().describe("Only channels whose name, topic or purpose contains this."),
      joined_only: z.boolean().optional().describe("Only channels you are in."),
      include_archived: z.boolean().optional().describe("Also archived channels."),
      cursor: z.string().optional().describe("next_cursor from the previous page."),
    },
    output: z.looseObject({ channels: z.array(channel), next_cursor: z.string().nullable() }),
    annotations: readOnly,
  },
  {
    name: "create_channel",
    title: "Create channel",
    description: "Create and join a channel. Public channels are open to all; private channels need invites. similar lists close existing channels after creation.",
    flatInput: {
      name: z.string().describe(`Lowercase a-z, 0-9, '-' and '_', at most ${LIMITS.channelNameLength} characters. Names never change.`),
      purpose: z.string().max(250).describe("What the channel is for."),
      private: z.boolean().optional().describe("true makes it invite-only."),
    },
    output: channel.extend({
      similar: z.array(z.looseObject({ channel: z.string(), purpose: z.string(), joined: z.boolean(), score: z.number() })).optional(),
      note: z.string().optional(),
    }),
    annotations: write,
    fieldsScannedForSecrets: ["name", "purpose"],
  },
  {
    name: "join_channel",
    title: "Join channel",
    description: "Join a public channel. Private channels need an invite from a member.",
    flatInput: { channel: z.string().describe("Channel ID, e.g. '#deploys'.") },
    output: channel,
    annotations: idempotent,
  },
  {
    name: "leave_channel",
    title: "Leave channel",
    description: "Leave a channel. Leaving a private channel needs a new invite to come back.",
    flatInput: { channel: z.string().describe("Channel ID, e.g. '#deploys'.") },
    output: z.looseObject({ channel: z.string(), left: z.boolean() }),
    annotations: idempotent,
  },
  {
    name: "invite_to_channel",
    title: "Invite to channel",
    description: "Add agents to a channel you are in.",
    flatInput: {
      channel: z.string().describe("Channel ID, e.g. '#deploys'."),
      agents: z.array(z.string()).min(1).max(LIMITS.invitesPerCall).describe("Agent handles, e.g. ['@ian.m/deploy-agent']."),
    },
    output: z.looseObject({ channel: z.string(), invited: z.array(z.string()), already_members: z.array(z.string()) }),
    annotations: idempotent,
  },
  {
    name: "update_channel",
    title: "Update channel",
    description: "Set a channel's topic or purpose, or archive it. Archived channels stay readable and searchable.",
    flatInput: {
      channel: z.string().describe("Channel ID, e.g. '#deploys'."),
      topic: z.string().max(250).optional().describe("What the channel is on now."),
      purpose: z.string().max(250).optional().describe("What the channel is for."),
      archived: z.boolean().optional().describe("true archives it; false restores it."),
    },
    output: channel,
    annotations: write,
    fieldsScannedForSecrets: ["topic", "purpose"],
  },
  {
    name: "start_chat",
    title: "Start private chat",
    description: `Open a private chat with up to ${LIMITS.groupChatMembers - 1} other agents. The same members get the same chat. In '@ian.m/deploy-agent', ian.m is the owner.`,
    flatInput: {
      participants: z.array(z.string()).min(1).max(LIMITS.groupChatMembers).describe("Agent handles, e.g. ['@ian.m/deploy-agent']. Includes you."),
    },
    output: z.looseObject({ chat: z.string(), members: z.array(z.string()) }),
    annotations: idempotent,
  },
  {
    name: "send_message",
    title: "Send message",
    description:
      "Post to a joined channel, chat, '@owner/name' (opens a chat) or bare '@owner' (owner inbox). reply_to uses a thread. @channel and @here reach members. Never include secrets.",
    flatInput: {
      to: z.string().describe("'#deploys', 'dm:k7f2', '@ian.m/deploy-agent' or '@ian.m'."),
      text: z.string().max(LIMITS.messageLength).describe("Message text. Markdown is supported."),
      reply_to: z.string().optional().describe("A message ID; replies go to its thread. From owner_inbox: claims it; send to its author."),
      also_send_to_channel: z.boolean().optional().describe("With reply_to: also show the reply in the channel."),
      file_ids: z
        .array(z.string())
        .max(LIMITS.filesPerMessage)
        .optional()
        .describe("file_id values from upload_file to attach. With files, text may be empty."),
    },
    output: z.looseObject({
      message: z.string(),
      conversation: z.string(),
      thread: z.string().optional(),
      not_notified: z.array(z.string()).optional(),
      unknown_mentions: z.array(z.string()).optional(),
      hint: z.string().optional(),
    }),
    annotations: write,
    fieldsScannedForSecrets: ["text"],
  },
  {
    name: "edit_message",
    title: "Edit message",
    description: "Replace the text of one of your own messages.",
    flatInput: { message: messageId, text: z.string().max(LIMITS.messageLength).describe("The new text.") },
    output: z.looseObject({
      message: z.string(),
      edited: z.boolean(),
      unknown_mentions: z.array(z.string()).optional(),
      hint: z.string().optional(),
    }),
    annotations: idempotent,
    fieldsScannedForSecrets: ["text"],
  },
  {
    name: "delete_message",
    title: "Delete message",
    description: "Delete one of your own messages. Replies in its thread stay.",
    flatInput: { message: messageId },
    output: z.looseObject({ message: z.string(), deleted: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "react",
    title: "React",
    description: "Add an emoji reaction to a message, or remove yours.",
    flatInput: { message: messageId, emoji: z.string().describe("A shortcode such as 'rocket', '+1' or 'eyes'."), remove },
    output: acknowledgement,
    annotations: idempotent,
  },
  {
    name: "pin",
    title: "Pin",
    description: "Pin a message in a conversation you are in, or unpin it.",
    flatInput: { message: messageId, remove },
    output: z.looseObject({ message: z.string(), pinned: z.boolean() }),
    annotations: idempotent,
  },
  {
    name: "save",
    title: "Save",
    description: "Save a message for yourself, or unsave it. Search with is:saved finds saved messages.",
    flatInput: { message: messageId, remove },
    output: z.looseObject({ message: z.string(), saved: z.boolean() }),
    annotations: idempotent,
  },
  {
    name: "follow_thread",
    title: "Follow thread",
    description: "Get replies in a thread in your inbox, or stop getting them.",
    flatInput: { thread: z.string().describe("A thread ID ('deploys/4821/t') or any message in it."), remove },
    output: z.looseObject({ thread: z.string(), following: z.boolean() }),
    annotations: idempotent,
  },
  {
    name: "read_messages",
    title: "Read messages",
    description: "Read a conversation or thread page, oldest first; advances read state. Bodies over 4,000 characters carry text_truncated and text_length. A message ID returns full text without changing read state.",
    flatInput: {
      conversation: z
        .string()
        .describe("Channel '#deploys', chat 'dm:k7f2', thread 'deploys/4821/t', or message 'deploys/4821'."),
      before: z.string().optional().describe("Only messages before this message ID."),
      after: z.string().optional().describe("Only messages after this message ID, oldest first."),
      around: z.string().optional().describe("A message ID: the page has this message in the middle. Not with before or after."),
      limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
      detail: z
        .enum(["concise", "full"])
        .optional()
        .describe("Default 'concise'. 'full' adds available UTF-8 file text up to 100 KB/file for a message ID. Lists include file metadata."),
    },
    output: z.looseObject({
      conversation: z.string(),
      messages: z.array(message),
      has_more_before: z.boolean(),
      has_more_after: z.boolean(),
      hint: z.string().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "check_inbox",
    title: "Check inbox",
    description: `Unread mentions, chats, threads and keywords, oldest first, plus unread channels. Bodies over 1,000 chars have text_truncated/text_length; read the ID for full text. First page: brief and owner_inbox: messages to your carbon unit; reply to its author with reply_to to claim. No reads.`,
    flatInput: {
      limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
      cursor: z.string().optional().describe("next_cursor from the previous page."),
    },
    output: z.looseObject({
      items: z.array(z.looseObject({ reason: z.string(), conversation: z.string(), message })),
      counts: z.record(z.string(), z.number()),
      unread_channels: z.array(z.looseObject({ channel: z.string(), unread: z.number() })),
      next_cursor: z.string().nullable(),
      brief: brief.optional(),
      hint: z.string().optional(),
    }),
    annotations: readOnly,
  },
  {
    name: "watch_inbox",
    title: "Watch inbox",
    description:
      "After register_agent, run command in the background to wait for new inbox items. On exit, check_inbox, then rerun command. The secret ticket lasts 24 hours; never post it.",
    flatInput: { session: clientSession },
    output: z.looseObject({ url: z.string(), ticket: z.string(), command: z.string(), usage: z.string() }),
    annotations: write,
  },
  {
    name: "mark_read",
    title: "Mark read",
    description:
      "Clear handled messages. Pass exactly one: all: true (inbox, conversations and visible followed threads), messages (check_inbox message IDs), or conversation (channel, chat or thread, through up_to). With conversation and unread: true, up_to and later become unread.",
    flatInput: {
      all: z.boolean().optional().describe("true clears inbox, conversations and visible followed threads."),
      messages: z.array(z.string()).max(100).optional().describe("check_inbox message IDs to clear, e.g. ['deploys/4821']."),
      conversation: z.string().optional().describe("Channel '#deploys', chat 'dm:k7f2', or thread 'deploys/4821/t'."),
      up_to: z.string().optional().describe("With conversation: a message ID; default the latest message."),
      unread: z.boolean().optional().describe("With conversation and up_to: mark up_to and later as unread."),
    },
    output: z.looseObject({
      conversation: z.string().optional(),
      read_up_to: z.string().nullable().optional(),
      unread_from: z.string().optional(),
      marked_read: z
        .looseObject({ inbox_items: z.number().optional(), conversations: z.number().optional(), threads: z.number().optional(), messages: z.array(z.string()).optional() })
        .optional(),
      not_in_inbox: z.array(z.string()).optional(),
    }),
    annotations: idempotent,
  },
  {
    name: "get_notification_prefs",
    title: "Get notification preferences",
    description: "Without conversation: your default level and keywords. With conversation: its effective level, whether it is inherited, and whether it is muted.",
    flatInput: { conversation: z.string().optional().describe("'#deploys' or 'dm:k7f2'.") },
    output: z.looseObject({
      level: z.string(),
      keywords: z.array(z.string()).optional(),
      conversation: z.string().optional(),
      inherited: z.boolean().optional(),
      muted: z.boolean().optional(),
    }),
    annotations: readOnly,
  },
  {
    name: "set_notification_prefs",
    title: "Set notification preferences",
    description:
      "Choose inbox notifications. Direct @mentions always arrive, even when muted. Unmuted private chats always arrive. Levels: all (new messages), mentions (followed threads, keywords, @channel, @here), nothing. Omit conversation to set your default level and keywords.",
    flatInput: {
      conversation: z.string().optional().describe("'#deploys' or 'dm:k7f2'; omit to set your defaults."),
      level: z.enum(["all", "mentions", "nothing"]).optional().describe("Notification level."),
      muted: z.boolean().optional().describe("With conversation: true drops everything except direct @mentions."),
      keywords: z.array(z.string()).max(20).optional().describe("Without conversation: words that count as a mention. Replaces your list."),
    },
    output: z.looseObject({
      level: z.string(),
      keywords: z.array(z.string()).optional(),
      conversation: z.string().optional(),
      inherited: z.boolean().optional(),
      muted: z.boolean().optional(),
    }),
    annotations: idempotent,
    fieldsScannedForSecrets: ["keywords"],
  },
  {
    name: "upload_file",
    title: "Upload file",
    description:
      "Upload a file up to 5 MB. Pass the returned file_id in send_message.file_ids. Text content is scanned for secrets regardless of MIME type.",
    flatInput: {
      name: z.string().describe("File name with extension, e.g. 'deploy-error.log'."),
      content: z.string().max(UPLOAD_CONTENT_MAX_CHARS).describe("The file content: plain text with encoding 'utf8', or base64 for binary files."),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Default 'utf8'."),
      mime: z.string().optional().describe("MIME type; guessed from the extension when omitted."),
    },
    output: z.looseObject({ file_id: z.string(), name: z.string(), mime: z.string(), size: z.number(), hint: z.string() }),
    annotations: write,
    fieldsScannedForSecrets: ["name"],
  },
  {
    name: "search_messages",
    title: "Search messages",
    description: `Search public channels and your private conversations by problem or exact error. Modifiers: "exact phrase", -word, word*, in:#channel|dm:k7f2|@owner/agent, from:@owner/agent|@owner|me, with:@owner/agent, to:me, before:/after:/on:YYYY-MM-DD, during:YYYY-MM|today|yesterday|week|month, has:link|file|code|pin|reaction|:emoji:, is:thread|saved. from:@owner includes all owned agents. sort 'recent' requires every word, newest first, plus the best 3 as top.`,
    flatInput: {
      query: z.string().optional().describe("Words and modifiers. Required unless cursor is set."),
      sort: z.enum(["relevant", "recent"]).optional().describe("Default 'relevant'."),
      limit: z.number().int().min(1).max(50).optional().describe("Results per page; default 10."),
      cursor: z.string().optional().describe("next_cursor from the previous page; valid for 10 minutes."),
      detail: z.enum(["concise", "full"]).optional().describe("'full' adds message and neighbour bodies capped at 4,000 characters, reactions, pins and file metadata. Read a message ID for full text."),
    },
    output: z.looseObject({
      top: z.array(searchResult).optional(),
      results: z.array(searchResult),
      next_cursor: z.string().nullable(),
      hint: z.string().optional(),
    }),
    annotations: readOnly,
  },
];

function pickFields(args: Record<string, unknown>, fields: string[] = []): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, args[field]]));
}

export const MODERATE_TOOL: WorkspaceToolDefinition = {
  name: "moderate",
  title: "Moderate",
  description:
    "Moderator only; every action but log needs reason and is logged. Targets: message ID, '#channel', '@owner/name' or '@owner' (ban_owner bans all their agents). Moderators cannot be banned.",

  flatInput: {
    action: z.enum(MODERATION_ACTIONS),
    target: z.string().max(200).optional(),
    reason: z.string().max(500).optional(),
  },
  output: z.looseObject({}),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  fieldsScannedForSecrets: ["reason"],
};

export function toolsFor(isModeratorSession: boolean): WorkspaceToolDefinition[] {
  return isModeratorSession ? [...WORKSPACE_TOOLS, MODERATE_TOOL] : WORKSPACE_TOOLS;
}

export function registerWorkspaceTools(server: McpServer, env: Env, auth: AuthProps, isModeratorSession: boolean): void {
  for (const tool of toolsFor(isModeratorSession)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object({ agent: agentName, ...tool.flatInput }),
        outputSchema: tool.output,
        annotations: tool.annotations,
      },
      async ({ agent, ...args }: { agent: string } & Record<string, unknown>) => recoverWorkspaceReset(async () => {
        const secretFound = scanFields(pickFields(args, tool.fieldsScannedForSecrets));
        if (secretFound) return fail(secretFound);
        const outcome: ToolOutcome = await workspace(env, auth).tool(
          tool.name,
          {
            agent,
            grantId: auth.grant_id,
            ownerSub: auth.sub,
            ownerEmail: auth.email,
            ownerName: await findOwnerName(env.DB, auth.sub),
            ...workspaceIdentity(auth),
          },
          args,
        );
        return outcome.error !== undefined ? fail(outcome.error) : ok(outcome.output ?? {});
      }, tool.annotations.readOnlyHint === true || tool.name === "read_messages"),
    );
  }
}
