#!/usr/bin/env node
import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from 'zod';
import { isSlackError, formatSlackError } from "./common/errors.js";
import { AsyncLocalStorage } from "async_hooks";


// Type definitions for tool arguments
interface ListChannelsArgs {
  limit?: number;
  cursor?: string;
}

interface PostMessageArgs {
  channel_id: string;
  text: string;
}

interface ReplyToThreadArgs {
  channel_id: string;
  thread_ts: string;
  text: string;
}

interface AddReactionArgs {
  channel_id: string;
  timestamp: string;
  reaction: string;
}

interface GetChannelHistoryArgs {
  channel_id: string;
  limit?: number;
}

interface GetThreadRepliesArgs {
  channel_id: string;
  thread_ts: string;
}

interface GetUsersArgs {
  cursor?: string;
  limit?: number;
}

interface GetUserProfileArgs {
  user_id: string;
}

// Tool definitions
const listChannelsTool: Tool = {
  name: "slack_list_channels",
  description: "List public channels in the workspace with pagination",
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description:
          "Maximum number of channels to return (default 100, max 200)",
        default: 100,
      },
      cursor: {
        type: "string",
        description: "Pagination cursor for next page of results",
      },
    },
  },
};

const postMessageTool: Tool = {
  name: "slack_post_message",
  description: "Post a new message to a Slack channel",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel to post to",
      },
      text: {
        type: "string",
        description: "The message text to post",
      },
    },
    required: ["channel_id", "text"],
  },
};

const replyToThreadTool: Tool = {
  name: "slack_reply_to_thread",
  description: "Reply to a specific message thread in Slack",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel containing the thread",
      },
      thread_ts: {
        type: "string",
        description: "The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it.",
      },
      text: {
        type: "string",
        description: "The reply text",
      },
    },
    required: ["channel_id", "thread_ts", "text"],
  },
};

const addReactionTool: Tool = {
  name: "slack_add_reaction",
  description: "Add a reaction emoji to a message",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel containing the message",
      },
      timestamp: {
        type: "string",
        description: "The timestamp of the message to react to",
      },
      reaction: {
        type: "string",
        description: "The name of the emoji reaction (without ::)",
      },
    },
    required: ["channel_id", "timestamp", "reaction"],
  },
};

const getChannelHistoryTool: Tool = {
  name: "slack_get_channel_history",
  description: "Get recent messages from a channel",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel",
      },
      limit: {
        type: "number",
        description: "Number of messages to retrieve (default 10)",
        default: 10,
      },
    },
    required: ["channel_id"],
  },
};

const getThreadRepliesTool: Tool = {
  name: "slack_get_thread_replies",
  description: "Get all replies in a message thread",
  inputSchema: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "The ID of the channel containing the thread",
      },
      thread_ts: {
        type: "string",
        description: "The timestamp of the parent message in the format '1234567890.123456'. Timestamps in the format without the period can be converted by adding the period such that 6 numbers come after it.",
      },
    },
    required: ["channel_id", "thread_ts"],
  },
};

const getUsersTool: Tool = {
  name: "slack_get_users",
  description:
    "Get a list of all users in the workspace with their basic profile information",
  inputSchema: {
    type: "object",
    properties: {
      cursor: {
        type: "string",
        description: "Pagination cursor for next page of results",
      },
      limit: {
        type: "number",
        description: "Maximum number of users to return (default 100, max 200)",
        default: 100,
      },
    },
  },
};

const getUserProfileTool: Tool = {
  name: "slack_get_user_profile",
  description: "Get detailed profile information for a specific user",
  inputSchema: {
    type: "object",
    properties: {
      user_id: {
        type: "string",
        description: "The ID of the user",
      },
    },
    required: ["user_id"],
  },
};

class SlackClient {
  private botHeaders: { Authorization: string; "Content-Type": string };

  constructor(botToken: string) {
    this.botHeaders = {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    };
  }

  // Update token if needed
  refreshToken() {
    const token = getSlackToken();
    if (token) {
      this.botHeaders.Authorization = `Bearer ${token}`;
      return true;
    }
    return false;
  }

  // Update existing methods to call refreshToken before making API calls
  async getChannels(limit: number = 100, cursor?: string): Promise<any> {
    this.refreshToken();
    const params = new URLSearchParams({
      types: "public_channel",
      exclude_archived: "true",
      limit: Math.min(limit, 200).toString(),
      team_id: process.env.SLACK_TEAM_ID!,
    });

    if (cursor) {
      params.append("cursor", cursor);
    }

    const response = await fetch(
      `https://slack.com/api/conversations.list?${params}`,
      { headers: this.botHeaders },
    );

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  async postMessage(channel_id: string, text: string): Promise<any> {
    this.refreshToken();
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: this.botHeaders,
      body: JSON.stringify({
        channel: channel_id,
        text: text,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  async postReply(
    channel_id: string,
    thread_ts: string,
    text: string,
  ): Promise<any> {
    this.refreshToken();
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: this.botHeaders,
      body: JSON.stringify({
        channel: channel_id,
        thread_ts: thread_ts,
        text: text,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  async addReaction(
    channel_id: string,
    timestamp: string,
    reaction: string,
  ): Promise<any> {
    this.refreshToken();
    const response = await fetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: this.botHeaders,
      body: JSON.stringify({
        channel: channel_id,
        timestamp: timestamp,
        name: reaction,
      }),
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  async getChannelHistory(
    channel_id: string,
    limit: number = 10,
  ): Promise<any> {
    this.refreshToken();
    const params = new URLSearchParams({
      channel: channel_id,
      limit: limit.toString(),
    });

    const response = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers: this.botHeaders },
    );

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  async getThreadReplies(channel_id: string, thread_ts: string): Promise<any> {
    this.refreshToken();
    const params = new URLSearchParams({
      channel: channel_id,
      ts: thread_ts,
    });

    const response = await fetch(
      `https://slack.com/api/conversations.replies?${params}`,
      { headers: this.botHeaders },
    );

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  async getUsers(limit: number = 100, cursor?: string): Promise<any> {
    this.refreshToken();
    const params = new URLSearchParams({
      limit: Math.min(limit, 200).toString(),
      team_id: process.env.SLACK_TEAM_ID!,
    });

    if (cursor) {
      params.append("cursor", cursor);
    }

    const response = await fetch(`https://slack.com/api/users.list?${params}`, {
      headers: this.botHeaders,
    });

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }

  async getUserProfile(user_id: string): Promise<any> {
    this.refreshToken();
    const params = new URLSearchParams({
      user: user_id,
      include_labels: "true",
    });

    const response = await fetch(
      `https://slack.com/api/users.profile.get?${params}`,
      { headers: this.botHeaders },
    );

    const data = await response.json();

    if (!data.ok) {
      throw new Error(`Slack API error: ${data.error}`);
    }

    return data;
  }
}

const server = new Server(
  {
    name: "slack-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(
  ListToolsRequestSchema,
  async () => {
    return {
      tools: [
        listChannelsTool,
        postMessageTool,
        replyToThreadTool,
        addReactionTool,
        getChannelHistoryTool,
        getThreadRepliesTool,
        getUsersTool,
        getUserProfileTool,
      ],
    };
  }
);

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest) => {
    try {
      // Validate the request parameters
      if (!request.params?.name) {
        throw new Error("Missing tool name");
      }

      const slackToken = getSlackToken();
      if (!slackToken) {
        throw new Error("No valid Slack token found for this instance");
      }

      const slackClient = new SlackClient(slackToken);

      // Process the tool call based on the tool name
      switch (request.params.name) {
        case "slack_list_channels": {
          const args = request.params.arguments as unknown as ListChannelsArgs;
          const response = await slackClient.getChannels(
            args.limit,
            args.cursor,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        case "slack_post_message": {
          const args = request.params.arguments as unknown as PostMessageArgs;
          if (!args.channel_id || !args.text) {
            throw new Error(
              "Missing required arguments: channel_id and text",
            );
          }
          const response = await slackClient.postMessage(
            args.channel_id,
            args.text,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        case "slack_reply_to_thread": {
          const args = request.params.arguments as unknown as ReplyToThreadArgs;
          if (!args.channel_id || !args.thread_ts || !args.text) {
            throw new Error(
              "Missing required arguments: channel_id, thread_ts, and text",
            );
          }
          const response = await slackClient.postReply(
            args.channel_id,
            args.thread_ts,
            args.text,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        case "slack_add_reaction": {
          const args = request.params.arguments as unknown as AddReactionArgs;
          if (!args.channel_id || !args.timestamp || !args.reaction) {
            throw new Error(
              "Missing required arguments: channel_id, timestamp, and reaction",
            );
          }
          const response = await slackClient.addReaction(
            args.channel_id,
            args.timestamp,
            args.reaction,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        case "slack_get_channel_history": {
          const args = request.params.arguments as unknown as GetChannelHistoryArgs;
          if (!args.channel_id) {
            throw new Error("Missing required argument: channel_id");
          }
          const response = await slackClient.getChannelHistory(
            args.channel_id,
            args.limit,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        case "slack_get_thread_replies": {
          const args = request.params.arguments as unknown as GetThreadRepliesArgs;
          if (!args.channel_id || !args.thread_ts) {
            throw new Error(
              "Missing required arguments: channel_id and thread_ts",
            );
          }
          const response = await slackClient.getThreadReplies(
            args.channel_id,
            args.thread_ts,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        case "slack_get_users": {
          const args = request.params.arguments as unknown as GetUsersArgs;
          const response = await slackClient.getUsers(
            args.limit,
            args.cursor,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        case "slack_get_user_profile": {
          const args = request.params.arguments as unknown as GetUserProfileArgs;
          if (!args.user_id) {
            throw new Error("Missing required argument: user_id");
          }
          const response = await slackClient.getUserProfile(args.user_id);
          return {
            content: [{ type: "text", text: JSON.stringify(response) }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      console.error("Error executing tool:", error);

      if (isSlackError(error)) {
        throw new Error(formatSlackError(error));
      }

      if (error instanceof z.ZodError) {
        throw new Error(`Invalid input: ${JSON.stringify(error.errors)}`);
      }

      throw error;
    }
  }
);

const app = express();

const transports = new Map<string, SSEServerTransport>();

// Create AsyncLocalStorage for request context
const asyncLocalStorage = new AsyncLocalStorage<{
  slack_token: string;
}>();

function getSlackToken() {
  // First check if env var exists
  if (process.env.SLACK_AUTH_TOKEN) {
    return process.env.SLACK_AUTH_TOKEN;
  }
  // Fall back to token from request context
  return asyncLocalStorage.getStore()!.slack_token;
}

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport(`/messages`, res);

  // Set up cleanup when connection closes
  res.on('close', async () => {
    console.log(`SSE connection closed for transport: ${transport.sessionId}`);
    try {
      transports.delete(transport.sessionId);
    } finally {
    }
  });

  transports.set(transport.sessionId, transport);

  await server.connect(transport);

  console.log(`SSE connection established with transport: ${transport.sessionId}`);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;

  let transport: SSEServerTransport | undefined;
  transport = sessionId ? transports.get(sessionId) : undefined;
  if (transport) {
    const slack_token = req.headers['x-auth-token'] as string;

    asyncLocalStorage.run({ slack_token }, async () => {
      await transport.handlePostMessage(req, res);
    });
  } else {
    console.error(`Transport not found for session ID: ${sessionId}`);
    res.status(404).send({ error: "Transport not found" });
  }
});

app.listen(5000, () => {
  console.log('server running on port 5000');
});