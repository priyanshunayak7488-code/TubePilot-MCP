
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

// Properties saved during Google OAuth authorization.
export type Props = {
  name: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
};

function createServer() {
  const server = new McpServer({
    name: "TubePilot AI",
    version: "0.2.0",
  });

  // Read the authenticated user's encrypted OAuth properties.
  const props = getMcpAuthContext()?.props as
    | Props
    | undefined;

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

  // Tool 2: YouTube channel analytics.
  server.registerTool(
    "youtube_channel_analytics",
    {
      description:
        "Get real YouTube channel analytics for a date range, including views, watch time, average view duration, subscribers gained and subscribers lost.",
      inputSchema: z.object({
        startDate: z.string().regex(
          /^\d{4}-\d{2}-\d{2}$/,
          "Use YYYY-MM-DD format",
        ),
        endDate: z.string().regex(
          /^\d{4}-\d{2}-\d{2}$/,
          "Use YYYY-MM-DD format",
        ),
      }),
    },
    async ({ startDate, endDate }) => {
      try {
        if (startDate > endDate) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "Start date must not be later than end date.",
              },
            ],
          };
        }

        if (!props?.refreshToken) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "Google account is not connected. Please authorize TubePilot again.",
              },
            ],
          };
        }

        // Obtain a fresh Google access token.
        const [tokens, refreshError] =
          await refreshGoogleAccessToken({
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            refreshToken: props.refreshToken,
          });

        if (refreshError) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: await refreshError.text(),
              },
            ],
          };
        }

        // Request channel-level analytics.
        const analyticsUrl = new URL(
          "https://youtubeanalytics.googleapis.com/v2/reports",
        );

        analyticsUrl.searchParams.set(
          "ids",
          "channel==MINE",
        );
        analyticsUrl.searchParams.set(
          "startDate",
          startDate,
        );
        analyticsUrl.searchParams.set(
          "endDate",
          endDate,
        );
        analyticsUrl.searchParams.set(
          "metrics",
          "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
        );

        const response = await fetch(
          analyticsUrl.toString(),
          {
            method: "GET",
            headers: {
              Authorization:
                `Bearer ${tokens.access_token}`,
            },
          },
        );

        if (!response.ok) {
          const errorText = await response.text();

          console.error(
            "YouTube Analytics API error:",
            response.status,
          );

          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `YouTube Analytics API returned ${response.status}: ${errorText}`,
              },
            ],
          };
        }

        const report = await response.json();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  channel: props.name,
                  period: {
                    startDate,
                    endDate,
                  },
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
        console.error(
          "TubePilot analytics error:",
          error,
        );

        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                "Unable to retrieve YouTube analytics. Please try again.",
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
