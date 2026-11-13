
import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  getMcpAuthContext,
} from "agents/mcp/server";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { refreshGoogleAccessToken } from "./utils";

export type Props = {
  name: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
};

const dateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "Use YYYY-MM-DD format",
);

function createServer() {
  const server = new McpServer({
    name: "TubePilot AI",
    version: "0.3.0",
  });

  const props = getMcpAuthContext()?.props as
    | Props
    | undefined;

  // Shared date validation.
  function validateDates(startDate: string, endDate: string) {
    if (startDate > endDate) {
      return "Start date must not be later than end date.";
    }

    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);

    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      start.toISOString().slice(0, 10) !== startDate ||
      end.toISOString().slice(0, 10) !== endDate
    ) {
      return "Invalid calendar date. Use YYYY-MM-DD.";
    }

    return null;
  }

  // Shared Google access-token refresh.
  async function getGoogleAccessToken() {
    if (!props?.refreshToken) {
      throw new Error(
        "Google account is not connected. Please authorize TubePilot again.",
      );
    }

    const [tokens, refreshError] =
      await refreshGoogleAccessToken({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        refreshToken: props.refreshToken,
      });

    if (refreshError) {
      throw new Error(await refreshError.text());
    }

    return tokens.access_token;
  }

  // Tool 1: Connection test.
  server.registerTool(
    "add",
    {
      description:
        "Test that the TubePilot MCP server is responding.",
      inputSchema: z.object({
        a: z.number(),
        b: z.number(),
      }),
    },
    async ({ a, b }) => ({
      content: [
        {
          type: "text",
          text: String(a + b),
        },
      ],
    }),
  );

  // Tool 2: Channel-level analytics.
  server.registerTool(
    "youtube_channel_analytics",
    {
      description:
        "Get channel-level YouTube analytics including views, watch time, average view duration and subscriber changes.",
      inputSchema: z.object({
        startDate: dateSchema,
        endDate: dateSchema,
      }),
    },
    async ({ startDate, endDate }) => {
      try {
        const dateError = validateDates(startDate, endDate);

        if (dateError) {
          throw new Error(dateError);
        }

        const accessToken = await getGoogleAccessToken();

        const url = new URL(
          "https://youtubeanalytics.googleapis.com/v2/reports",
        );

        url.searchParams.set("ids", "channel==MINE");
        url.searchParams.set("startDate", startDate);
        url.searchParams.set("endDate", endDate);
        url.searchParams.set(
          "metrics",
          "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
        );

        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!response.ok) {
          throw new Error(
            `YouTube Analytics API returned ${response.status}: ${await response.text()}`,
          );
        }

        const report = await response.json();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  channel: props?.name,
                  period: { startDate, endDate },
                  source: "YouTube Analytics API",
                  report,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        console.error("Channel analytics error:", error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unable to retrieve channel analytics.",
            },
          ],
        };
      }
    },
  );

  // Tool 3: Individual video analytics.
  server.registerTool(
    "youtube_video_analytics",
    {
      description:
        "Get individual video performance from the authenticated YouTube channel, including video IDs, views, watch time, average view duration and subscriber changes. Results are sorted by views.",
      inputSchema: z.object({
        startDate: dateSchema,
        endDate: dateSchema,
        maxResults: z.number().int().min(1).max(200).default(100),
      }),
    },
    async ({ startDate, endDate, maxResults }) => {
      try {
        const dateError = validateDates(startDate, endDate);

        if (dateError) {
          throw new Error(dateError);
        }

        const accessToken = await getGoogleAccessToken();

        const url = new URL(
          "https://youtubeanalytics.googleapis.com/v2/reports",
        );

        url.searchParams.set("ids", "channel==MINE");
        url.searchParams.set("startDate", startDate);
        url.searchParams.set("endDate", endDate);
        url.searchParams.set(
          "metrics",
          "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
        );
        url.searchParams.set("dimensions", "video");
        url.searchParams.set("sort", "-views");
        url.searchParams.set("maxResults", String(maxResults));

        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!response.ok) {
          throw new Error(
            `YouTube Analytics API returned ${response.status}: ${await response.text()}`,
          );
        }

        const report = await response.json();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  channel: props?.name,
                  period: { startDate, endDate },
                  resultType: "Individual video analytics",
                  sortedBy: "Views descending",
                  source: "YouTube Analytics API",
                  report,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        console.error("Video analytics error:", error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof Error
                  ? error.message
                  : "Unable to retrieve video analytics.",
            },
          ],
        };
      }
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider<Env>({
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      return mcpHandler(request, env, ctx);
    },
  },
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: GoogleHandler as any,
  tokenEndpoint: "/token",
  resourceMetadata: {
    resource: env.MCP_RESOURCE,
  },
});
