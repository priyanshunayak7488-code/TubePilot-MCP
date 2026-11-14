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

type YouTubeVideo = {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  channelId: string;
  channelTitle: string;
  durationSeconds: number;
  views: number;
  likes: number | null;
  comments: number | null;
  thumbnail: string | null;
  videoUrl: string;
};

function createServer() {
  const server = new McpServer({
    name: "TubePilot AI",
    version: "1.0.0",
  });

  const props = getMcpAuthContext()?.props as
    | Props
    | undefined;

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

  async function getGoogleAccessToken(): Promise<string> {
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
      throw new Error(
        `Google token refresh failed: ${await refreshError.text()}`,
      );
    }

    if (!tokens?.access_token) {
      throw new Error(
        "Google did not return an access token. Please reconnect your account.",
      );
    }

    return tokens.access_token;
  }

  function durationToSeconds(duration: string): number {
    const match = duration.match(
      /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/,
    );

    if (!match) return 0;

    return (
      Number(match[1] || 0) * 3600 +
      Number(match[2] || 0) * 60 +
      Number(match[3] || 0)
    );
  }

  function median(values: number[]): number | null {
    if (values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  }

  function percentage(value: number, total: number): number | null {
    return total > 0
      ? Number(((value / total) * 100).toFixed(1))
      : null;
  }
  function errorResult(
    label: string,
    error?: unknown,
  ) {
    console.error(`${label}:`, error);

    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof Error
            ? error.message
            : `Unable to complete ${label.toLowerCase()}.`,
        },
      ],
    };
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
        if (dateError) throw new Error(dateError);

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
        return errorResult("Channel analytics", error);
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
        if (dateError) throw new Error(dateError);

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
        return errorResult("Video analytics", error);
      }
    },
  );

  // Tool 4: YouTube video metadata.
  server.registerTool(
    "youtube_video_metadata",
    {
      description:
        "Retrieve YouTube video titles, descriptions, publication dates, durations, thumbnails and video URLs for up to 50 video IDs. Identifies potential Shorts based on duration, but cannot verify aspect ratio.",
      inputSchema: z.object({
        videoIds: z.array(z.string().min(1)).min(1).max(50),
      }),
    },
    async ({ videoIds }) => {
      try {
        const uniqueIds = [...new Set(videoIds)];
        const accessToken = await getGoogleAccessToken();

        const url = new URL(
          "https://www.googleapis.com/youtube/v3/videos",
        );

        url.searchParams.set("part", "snippet,contentDetails");
        url.searchParams.set("id", uniqueIds.join(","));

        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!response.ok) {
          throw new Error(
            `YouTube Data API returned ${response.status}: ${await response.text()}`,
          );
        }

        const data = await response.json() as {
          items?: Array<{
            id: string;
            snippet: {
              title: string;
              description: string;
              publishedAt: string;
              channelTitle: string;
              thumbnails?: {
                high?: { url: string };
                medium?: { url: string };
                default?: { url: string };
              };
            };
            contentDetails: {
              duration: string;
            };
          }>;
        };

        const videos = (data.items || []).map((video) => {
          const durationSeconds = durationToSeconds(
            video.contentDetails.duration,
          );

          return {
            videoId: video.id,
            title: video.snippet.title,
            description: video.snippet.description,
            publishedAt: video.snippet.publishedAt,
            channelTitle: video.snippet.channelTitle,
            duration: video.contentDetails.duration,
            durationSeconds,
            formatCandidate: durationSeconds <= 180
              ? "Potential Short — verify aspect ratio"
              : "Long-form candidate",
            thumbnail:
              video.snippet.thumbnails?.high?.url ||
              video.snippet.thumbnails?.medium?.url ||
              video.snippet.thumbnails?.default?.url ||
              null,
            videoUrl:
              `https://www.youtube.com/watch?v=${video.id}`,
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  channel: props?.name,
                  requestedVideos: uniqueIds.length,
                  returnedVideos: videos.length,
                  missingOrUnavailableIds: uniqueIds.filter(
                    (id) =>
                      !videos.some((video) => video.videoId === id),
                  ),
                  source: "YouTube Data API v3",
                  videos,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult("Video metadata", error);
      }
    },
  );
  // Tool 5: Public YouTube video search.
  server.registerTool(
    "youtube_public_video_search",
    {
      description:
        "Search public YouTube videos by keyword. Retrieve video statistics and channel subscriber counts, and identify channels strictly below a subscriber threshold.",
      inputSchema: z.object({
        query: z.string().min(2).max(100),
        maxResults: z.number().int().min(1).max(50).default(25),
        order: z.enum(["relevance", "date", "viewCount"]).default("viewCount"),
        maxSubscribers: z.number().int().min(1).max(50000000).default(50000),
      }),
    },
    async ({ query, maxResults, order, maxSubscribers }) => {
      try {
        const accessToken = await getGoogleAccessToken();
        const headers = {
          Authorization: `Bearer ${accessToken}`,
        };

        const searchUrl = new URL(
          "https://www.googleapis.com/youtube/v3/search",
        );

        searchUrl.searchParams.set("part", "snippet");
        searchUrl.searchParams.set("type", "video");
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("maxResults", String(maxResults));
        searchUrl.searchParams.set("order", order);

        const searchResponse = await fetch(searchUrl.toString(), {
          headers,
        });

        if (!searchResponse.ok) {
          throw new Error(
            `YouTube search API returned ${searchResponse.status}: ${await searchResponse.text()}`,
          );
        }

        const searchData = await searchResponse.json() as {
          items?: Array<{
            id?: { videoId?: string };
            snippet?: {
              channelId?: string;
            };
          }>;
        };

        const searchItems = searchData.items || [];

        const videoIds = [
          ...new Set(
            searchItems
              .map((item) => item.id?.videoId)
              .filter((id): id is string => Boolean(id)),
          ),
        ];

        const channelIds = [
          ...new Set(
            searchItems
              .map((item) => item.snippet?.channelId)
              .filter((id): id is string => Boolean(id)),
          ),
        ];

        if (videoIds.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  query,
                  message: "No public videos found for this search.",
                  videos: [],
                }, null, 2),
              },
            ],
          };
        }

        if (channelIds.length === 0) {
          throw new Error(
            "Could not retrieve channel IDs for the search results.",
          );
        }

        const videosUrl = new URL(
          "https://www.googleapis.com/youtube/v3/videos",
        );

        videosUrl.searchParams.set(
          "part",
          "snippet,statistics,contentDetails",
        );
        videosUrl.searchParams.set("id", videoIds.join(","));

        const videosResponse = await fetch(videosUrl.toString(), {
          headers,
        });

        if (!videosResponse.ok) {
          throw new Error(
            `YouTube videos API returned ${videosResponse.status}: ${await videosResponse.text()}`,
          );
        }

        const videosData = await videosResponse.json() as {
          items?: Array<{
            id: string;
            snippet: {
              title: string;
              description: string;
              publishedAt: string;
              channelId: string;
              channelTitle: string;
              thumbnails?: {
                high?: { url: string };
                medium?: { url: string };
                default?: { url: string };
              };
            };
            statistics?: {
              viewCount?: string;
              likeCount?: string;
              commentCount?: string;
            };
            contentDetails?: {
              duration?: string;
            };
          }>;
        };

        // YouTube channels.list accepts at most 50 IDs per request.
        const channelMap = new Map<
          string,
          {
            id: string;
            statistics?: {
              subscriberCount?: string;
              hiddenSubscriberCount?: boolean;
            };
          }
        >();

        for (let i = 0; i < channelIds.length; i += 50) {
          const batch = channelIds.slice(i, i + 50);

          const channelsUrl = new URL(
            "https://www.googleapis.com/youtube/v3/channels",
          );

          channelsUrl.searchParams.set("part", "statistics");
          channelsUrl.searchParams.set("id", batch.join(","));

          const channelsResponse = await fetch(
            channelsUrl.toString(),
            { headers },
          );

          if (!channelsResponse.ok) {
            throw new Error(
              `YouTube channels API returned ${channelsResponse.status}: ${await channelsResponse.text()}`,
            );
          }

          const channelsData = await channelsResponse.json() as {
            items?: Array<{
              id: string;
              statistics?: {
                subscriberCount?: string;
                hiddenSubscriberCount?: boolean;
              };
            }>;
          };

          for (const channel of channelsData.items || []) {
            channelMap.set(channel.id, channel);
          }
        }

        const videos = (videosData.items || []).map((video) => {
          const channel = channelMap.get(video.snippet.channelId);
          const statistics = channel?.statistics;

          const subscriberCount =
            statistics?.subscriberCount !== undefined
              ? Number(statistics.subscriberCount)
              : null;

          const duration = video.contentDetails?.duration || "";
          const durationSeconds = duration
            ? durationToSeconds(duration)
            : null;

          const underLimit =
            subscriberCount !== null &&
            Number.isFinite(subscriberCount) &&
            subscriberCount < maxSubscribers;

          return {
            videoId: video.id,
            title: video.snippet.title,
            description: video.snippet.description,
            publishedAt: video.snippet.publishedAt,
            channelTitle: video.snippet.channelTitle,
            channelId: video.snippet.channelId,
            channelUrl:
              `https://www.youtube.com/channel/${video.snippet.channelId}`,
            subscriberCount,
            hiddenSubscriberCount:
              statistics?.hiddenSubscriberCount ?? false,
            views: Number(video.statistics?.viewCount || 0),
            likes: video.statistics?.likeCount !== undefined
              ? Number(video.statistics.likeCount)
              : null,
            comments: video.statistics?.commentCount !== undefined
              ? Number(video.statistics.commentCount)
              : null,
            duration,
            durationSeconds,
            formatCandidate:
              durationSeconds !== null && durationSeconds <= 180
                ? "Potential Short — verify aspect ratio"
                : "Long-form candidate",
            isUnderSubscriberLimit: underLimit,
            thumbnail:
              video.snippet.thumbnails?.high?.url ||
              video.snippet.thumbnails?.medium?.url ||
              video.snippet.thumbnails?.default?.url ||
              null,
            videoUrl:
              `https://www.youtube.com/watch?v=${video.id}`,
          };
        });

        const eligibleVideos = videos.filter(
          (video) => video.isUnderSubscriberLimit,
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  order,
                  subscriberLimit: maxSubscribers,
                  comparison: "Strictly fewer than subscriberLimit",
                  searchResults: searchItems.length,
                  videosRetrieved: videos.length,
                  eligibleVideos: eligibleVideos.length,
                  source: "YouTube Data API v3",
                  note:
                    "Channels with hidden subscriber counts cannot be verified against the subscriber limit and are not included in eligibleVideos. Duration alone cannot confirm whether a video is a Short; aspect ratio must also be checked.",
                  videos,
                  underSubscriberLimit: eligibleVideos,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult("Public video search", error);
      }
    },
  );

  // Tool 6: Public channel upload history and median-view baseline.
  server.registerTool(
    "youtube_channel_upload_history",
    {
      description:
        "Retrieve recent public uploads from up to 10 YouTube channels. Collect video statistics, durations and publication dates. Calculate separate median-view baselines for potential Shorts and long-form candidates using videos at least the requested minimum age.",
      inputSchema: z.object({
        channelIds: z.array(z.string().min(1)).min(1).max(10),
        maxUploadsPerChannel: z.number().int().min(1).max(30).default(30),
        minimumAgeDays: z.number().int().min(1).max(90).default(7),
      }),
    },
    async ({ channelIds, maxUploadsPerChannel, minimumAgeDays }) => {
      try {
        const uniqueChannelIds = [...new Set(channelIds)];
        const accessToken = await getGoogleAccessToken();
        const headers = {
          Authorization: `Bearer ${accessToken}`,
        };

        const channelsUrl = new URL(
          "https://www.googleapis.com/youtube/v3/channels",
        );

        channelsUrl.searchParams.set(
          "part",
          "snippet,contentDetails,statistics",
        );
        channelsUrl.searchParams.set(
          "id",
          uniqueChannelIds.join(","),
        );

        const channelsResponse = await fetch(
          channelsUrl.toString(),
          { headers },
        );

        if (!channelsResponse.ok) {
          throw new Error(
            `YouTube channels API returned ${channelsResponse.status}: ${await channelsResponse.text()}`,
          );
        }

        const channelsData = await channelsResponse.json() as {
          items?: Array<{
            id: string;
            snippet?: {
              title?: string;
            };
            contentDetails?: {
              relatedPlaylists?: {
                uploads?: string;
              };
            };
            statistics?: {
              subscriberCount?: string;
              hiddenSubscriberCount?: boolean;
            };
          }>;
        };

        const channelMap = new Map(
          (channelsData.items || []).map((channel) => [
            channel.id,
            channel,
          ]),
        );

        const missingChannelIds = uniqueChannelIds.filter(
          (id) => !channelMap.has(id),
        );

        const channelResults = await Promise.all(
          uniqueChannelIds.map(async (channelId) => {
            const channel = channelMap.get(channelId);

            if (!channel) {
              return {
                channelId,
                channelTitle: null,
                subscriberCount: null,
                hiddenSubscriberCount: false,
                error: "Channel not found or unavailable.",
                uploads: [] as Array<{
                  videoId: string;
                  playlistPublishedAt: string | null;
                }>,
              };
            }

            const uploadsPlaylistId =
              channel.contentDetails?.relatedPlaylists?.uploads;

            if (!uploadsPlaylistId) {
              return {
                channelId,
                channelTitle: channel.snippet?.title || null,
                subscriberCount:
                  channel.statistics?.subscriberCount !== undefined
                    ? Number(channel.statistics.subscriberCount)
                    : null,
                hiddenSubscriberCount:
                  channel.statistics?.hiddenSubscriberCount ?? false,
                error: "Uploads playlist unavailable.",
                uploads: [] as Array<{
                  videoId: string;
                  playlistPublishedAt: string | null;
                }>,
              };
            }

            const playlistUrl = new URL(
              "https://www.googleapis.com/youtube/v3/playlistItems",
            );

            playlistUrl.searchParams.set(
              "part",
              "contentDetails,snippet",
            );
            playlistUrl.searchParams.set(
              "playlistId",
              uploadsPlaylistId,
            );
            playlistUrl.searchParams.set(
              "maxResults",
              String(maxUploadsPerChannel),
            );

            const playlistResponse = await fetch(
              playlistUrl.toString(),
              { headers },
            );

            if (!playlistResponse.ok) {
              throw new Error(
                `Uploads playlist request failed for ${channelId}: ${await playlistResponse.text()}`,
              );
            }

            const playlistData = await playlistResponse.json() as {
              items?: Array<{
                contentDetails?: {
                  videoId?: string;
                  videoPublishedAt?: string;
                };
                snippet?: {
                  publishedAt?: string;
                  resourceId?: {
                    videoId?: string;
                  };
                };
              }>;
            };

            const uploads = (playlistData.items || [])
              .map((item) => ({
                videoId:
                  item.contentDetails?.videoId ||
                  item.snippet?.resourceId?.videoId ||
                  "",
                playlistPublishedAt:
                  item.contentDetails?.videoPublishedAt ||
                  item.snippet?.publishedAt ||
                  null,
              }))
              .filter((item) => item.videoId.length > 0);

            return {
              channelId,
              channelTitle: channel.snippet?.title || null,
              subscriberCount:
                channel.statistics?.subscriberCount !== undefined
                  ? Number(channel.statistics.subscriberCount)
                  : null,
              hiddenSubscriberCount:
                channel.statistics?.hiddenSubscriberCount ?? false,
              error: null,
              uploads,
            };
          }),
        );

        const allVideoIds = [
          ...new Set(
            channelResults.flatMap((channel) =>
              channel.uploads.map((upload) => upload.videoId),
            ),
          ),
        ];

        const videoMap = new Map<
          string,
          {
            id: string;
            title: string;
            description: string;
            publishedAt: string;
            duration: string;
            durationSeconds: number;
            views: number;
            likes: number | null;
            comments: number | null;
            thumbnail: string | null;
            videoUrl: string;
          }
        >();

        for (let i = 0; i < allVideoIds.length; i += 50) {
          const batch = allVideoIds.slice(i, i + 50);

          const videosUrl = new URL(
            "https://www.googleapis.com/youtube/v3/videos",
          );

          videosUrl.searchParams.set(
            "part",
            "snippet,statistics,contentDetails",
          );
          videosUrl.searchParams.set("id", batch.join(","));

          const videosResponse = await fetch(
            videosUrl.toString(),
            { headers },
          );

          if (!videosResponse.ok) {
            throw new Error(
              `YouTube videos API returned ${videosResponse.status}: ${await videosResponse.text()}`,
            );
          }

          const videosData = await videosResponse.json() as {
            items?: Array<{
              id: string;
              snippet: {
                title: string;
                description: string;
                publishedAt: string;
                thumbnails?: {
                  high?: { url: string };
                  medium?: { url: string };
                  default?: { url: string };
                };
              };
              statistics?: {
                viewCount?: string;
                likeCount?: string;
                commentCount?: string;
              };
              contentDetails?: {
                duration?: string;
              };
            }>;
          };

          for (const video of videosData.items || []) {
            const duration = video.contentDetails?.duration || "";
            const durationSeconds = duration
              ? durationToSeconds(duration)
              : 0;

            videoMap.set(video.id, {
              id: video.id,
              title: video.snippet.title,
              description: video.snippet.description,
              publishedAt: video.snippet.publishedAt,
              duration,
              durationSeconds,
              views: Number(video.statistics?.viewCount || 0),
              likes: video.statistics?.likeCount !== undefined
                ? Number(video.statistics.likeCount)
                : null,
              comments: video.statistics?.commentCount !== undefined
                ? Number(video.statistics.commentCount)
                : null,
              thumbnail:
                video.snippet.thumbnails?.high?.url ||
                video.snippet.thumbnails?.medium?.url ||
                video.snippet.thumbnails?.default?.url ||
                null,
              videoUrl:
                `https://www.youtube.com/watch?v=${video.id}`,
            });
          }
        }

        const now = Date.now();
        const minimumAgeMs =
          minimumAgeDays * 24 * 60 * 60 * 1000;

        const results = channelResults.map((channel) => {
          const uploads = channel.uploads
            .map((upload) => {
              const video = videoMap.get(upload.videoId);
              if (!video) return null;

              const ageMs =
                now - new Date(video.publishedAt).getTime();

              const ageDays = Math.max(
                0,
                Math.floor(ageMs / (24 * 60 * 60 * 1000)),
              );

              const potentialShort = video.durationSeconds <= 180;

              return {
                videoId: video.id,
                title: video.title,
                description: video.description,
                publishedAt: video.publishedAt,
                ageDays,
                duration: video.duration,
                durationSeconds: video.durationSeconds,
                formatCandidate: potentialShort
                  ? "Potential Short — verify aspect ratio"
                  : "Long-form candidate",
                views: video.views,
                likes: video.likes,
                comments: video.comments,
                thumbnail: video.thumbnail,
                videoUrl: video.videoUrl,
                oldEnoughForBaseline:
                  Number.isFinite(ageMs) && ageMs >= minimumAgeMs,
              };
            })
            .filter((video) => video !== null);

          const matureUploads = uploads.filter(
            (video) => video.oldEnoughForBaseline,
          );

          const potentialShorts = matureUploads.filter(
            (video) => video.durationSeconds <= 180,
          );

          const longForm = matureUploads.filter(
            (video) => video.durationSeconds > 180,
          );

          return {
            channelId: channel.channelId,
            channelTitle: channel.channelTitle,
            channelUrl:
              `https://www.youtube.com/channel/${channel.channelId}`,
            subscriberCount: channel.subscriberCount,
            hiddenSubscriberCount: channel.hiddenSubscriberCount,
            uploadCountRetrieved: uploads.length,
            minimumAgeDays,
            baseline: {
              potentialShorts: {
                videosUsed: potentialShorts.length,
                medianViews: median(
                  potentialShorts.map((video) => video.views),
                ),
              },
              longForm: {
                videosUsed: longForm.length,
                medianViews: median(
                  longForm.map((video) => video.views),
                ),
              },
            },
            uploads,
            error: channel.error,
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  source: "YouTube Data API v3",
                  requestedChannels: uniqueChannelIds.length,
                  channelsFound: results.filter(
                    (channel) => !channel.error,
                  ).length,
                  missingChannelIds,
                  maxUploadsPerChannel,
                  minimumAgeDays,
                  results,
                  notes: [
                    "A duration of 180 seconds or less identifies only a potential Short; aspect ratio is not provided by this API response.",
                    "Median baselines use only videos at least the requested minimum age.",
                    "Potential Shorts and long-form candidates have separate baselines.",
                    "A median is not calculated when a category has no mature uploads.",
                    "This tool retrieves public uploads; it does not provide private channel analytics.",
                  ],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult("Channel upload history", error);
      }
    },
  );
  // TOOL 7: YOUTUBE VIDEO OUTLIER DETECTOR
  server.registerTool(
  "youtube_video_outlier_detector",
  {
    description:
      "Check whether a YouTube video is outperforming its own channel baseline. Compares the target against older, mature uploads of the same duration-based format. Uses median views and reports sample-size confidence.",
    inputSchema: z.object({
      videoId: z
        .string()
        .min(6)
        .max(20)
        .describe("The YouTube video ID to evaluate"),

      minimumAgeDays: z
        .number()
        .int()
        .min(0)
        .max(365)
        .default(7)
        .describe("Minimum age in days for comparable uploads"),

      maxComparableVideos: z
        .number()
        .int()
        .min(5)
        .max(50)
        .default(30)
        .describe("Maximum number of comparable uploads to analyze"),
        }),
  },
  async ({ videoId, minimumAgeDays, maxComparableVideos }) => {
      try {
        const accessToken = await getGoogleAccessToken();

        const headers = {
          Authorization: `Bearer ${accessToken}`,
        };

        // 1. Retrieve the target video.
        const targetUrl = new URL(
          "https://www.googleapis.com/youtube/v3/videos"
        );

        targetUrl.searchParams.set("part", "snippet,statistics,contentDetails");
        targetUrl.searchParams.set("id", videoId);

        const targetResponse = await fetch(targetUrl, { headers });

        if (!targetResponse.ok) {
          return errorResult(
            `YouTube API error while retrieving the target video: ${targetResponse.status}`
          );
        }

        const targetData: any = await targetResponse.json();
        const target = targetData.items?.[0];

        if (!target) {
          return errorResult(
            "The target video was not found or is not publicly accessible."
          );
        }

        const targetChannelId = target.snippet?.channelId;
        const targetPublishedAt = target.snippet?.publishedAt;
        const targetDuration = durationToSeconds(
          target.contentDetails?.duration
        );
        const targetViews = Number(target.statistics?.viewCount ?? 0);

        if (!targetChannelId || !targetPublishedAt) {
          return errorResult(
            "The target video is missing the channel or publication information required for comparison."
          );
        }

        const targetDate = new Date(targetPublishedAt);

        if (Number.isNaN(targetDate.getTime())) {
          return errorResult("The target video has an invalid publication date.");
        }

        const targetFormat =
          targetDuration <= 180 ? "potential_shorts" : "long_form";

        // 2. Retrieve the channel's uploads playlist.
        const channelUrl = new URL(
          "https://www.googleapis.com/youtube/v3/channels"
        );

        channelUrl.searchParams.set("part", "contentDetails");
        channelUrl.searchParams.set("id", targetChannelId);

        const channelResponse = await fetch(channelUrl, { headers });

        if (!channelResponse.ok) {
          return errorResult(
            `YouTube API error while retrieving channel information: ${channelResponse.status}`
          );
        }

        const channelData: any = await channelResponse.json();
        const uploadsPlaylistId =
          channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

        if (!uploadsPlaylistId) {
          return errorResult(
            "Could not retrieve the channel's public uploads playlist."
          );
        }

        // 3. Find the target in the channel's uploads history.
        // Search up to 20 pages, with 50 uploads per page.
        const playlistVideoIds: string[] = [];
        let pageToken: string | undefined;
        let targetFound = false;
        let pagesChecked = 0;

        for (let page = 0; page < 20; page++) {
          const playlistUrl = new URL(
            "https://www.googleapis.com/youtube/v3/playlistItems"
          );

          playlistUrl.searchParams.set("part", "contentDetails,snippet");
          playlistUrl.searchParams.set("playlistId", uploadsPlaylistId);
          playlistUrl.searchParams.set("maxResults", "50");

          if (pageToken) {
            playlistUrl.searchParams.set("pageToken", pageToken);
          }

          const playlistResponse = await fetch(playlistUrl, { headers });

          if (!playlistResponse.ok) {
            return errorResult(
              `YouTube API error while retrieving upload history: ${playlistResponse.status}`
            );
          }

          const playlistData: any = await playlistResponse.json();
          pagesChecked++;

          const items = playlistData.items ?? [];

          for (const item of items) {
            const currentId = item.contentDetails?.videoId;

            if (!currentId) continue;

            if (currentId === videoId) {
              targetFound = true;
              break;
            }

            playlistVideoIds.push(currentId);
          }

          if (targetFound) break;

          pageToken = playlistData.nextPageToken;

          if (!pageToken) break;
        }

        if (!targetFound) {
          return errorResult(
            "The target video was not found within the first 1,000 uploads in the channel's public uploads playlist. The detector cannot reliably establish which uploads came before it."
          );
        }

        // 4. Retrieve details for uploads published before the target.
        const videoDetails: any[] = [];

        for (let i = 0; i < playlistVideoIds.length; i += 50) {
          const batch = playlistVideoIds.slice(i, i + 50);

          if (batch.length === 0) continue;

          const videosUrl = new URL(
            "https://www.googleapis.com/youtube/v3/videos"
          );

          videosUrl.searchParams.set(
            "part",
            "snippet,statistics,contentDetails"
          );
          videosUrl.searchParams.set("id", batch.join(","));

          const videosResponse = await fetch(videosUrl, { headers });

          if (!videosResponse.ok) {
            return errorResult(
              `YouTube API error while retrieving comparable videos: ${videosResponse.status}`
            );
          }

          const videosData: any = await videosResponse.json();
          videoDetails.push(...(videosData.items ?? []));
        }

        // 5. Apply age and format filters.
        const now = Date.now();
        const minimumAgeMs = minimumAgeDays * 24 * 60 * 60 * 1000;

        const comparableVideos = videoDetails
          .map((video) => {
            const publishedAt = video.snippet?.publishedAt;

            if (!publishedAt) return undefined;

            const publishedDate = new Date(publishedAt);

            if (Number.isNaN(publishedDate.getTime())) {
              return undefined;
            }

            const durationSeconds = durationToSeconds(
              video.contentDetails?.duration
            );

            const views = Number(video.statistics?.viewCount ?? 0);

            return {
              videoId: video.id,
              title: video.snippet?.title ?? "Untitled",
              publishedAt,
              durationSeconds,
              views,
              videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
              ageMs: now - publishedDate.getTime(),
              publishedTime: publishedDate.getTime(),
            };
          })
          .filter(
            (video): video is NonNullable<typeof video> =>
              video !== undefined
          )
          .filter((video) => {
            // Only videos published before the target are eligible.
            if (video.publishedTime >= targetDate.getTime()) {
              return false;
            }

            // Exclude uploads that have not reached the minimum age.
            if (video.ageMs < minimumAgeMs) {
              return false;
            }

            // Compare only videos in the same duration-based category.
            const videoFormat =
              video.durationSeconds <= 180
                ? "potential_shorts"
                : "long_form";

            return videoFormat === targetFormat;
          })
          .sort((a, b) => b.publishedTime - a.publishedTime)
          .slice(0, maxComparableVideos);

        // 6. Calculate the channel baseline and outlier multiplier.
        const baselineViews = median(
          comparableVideos.map((video) => video.views)
        );

        const sampleSize = comparableVideos.length;

        let confidence = "Insufficient data";

        if (sampleSize >= 20) {
          confidence = "High";
        } else if (sampleSize >= 10) {
          confidence = "Medium";
        } else if (sampleSize >= 5) {
          confidence = "Low";
        }

        let outlierMultiplier: number | null = null;
        let performanceLabel = "Insufficient data";

                if (
          sampleSize >= 5 &&
          baselineViews !== null &&
          baselineViews > 0
        ) {
          outlierMultiplier =
            Math.round((targetViews / baselineViews) * 100) / 100;

          if (outlierMultiplier >= 5) {
            performanceLabel = "Strong outlier";
          } else if (outlierMultiplier >= 3) {
            performanceLabel = "Potential outlier";
          } else if (outlierMultiplier >= 1.5) {
            performanceLabel = "Above channel baseline";
          } else if (outlierMultiplier >= 0.75) {
            performanceLabel = "Near channel baseline";
          } else {
            performanceLabel = "Below channel baseline";
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  tool: "youtube_video_outlier_detector",
                  targetVideo: {
                    videoId,
                    title: target.snippet?.title ?? "Untitled",
                    channelTitle:
                      target.snippet?.channelTitle ?? "Unknown channel",
                    channelId: targetChannelId,
                    publishedAt: targetPublishedAt,
                    durationSeconds: targetDuration,
                    format: targetFormat,
                    views: targetViews,
                    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
                  },
                  analysis: {
                    comparableVideosAnalyzed: sampleSize,
                    maximumComparableVideos: maxComparableVideos,
                    minimumAgeDays,
                    baselineMedianViews: baselineViews,
                    outlierMultiplier,
                    performanceLabel,
                    confidence,
                  },
                  comparableVideos: comparableVideos.map((video) => ({
                    videoId: video.videoId,
                    title: video.title,
                    publishedAt: video.publishedAt,
                    durationSeconds: video.durationSeconds,
                    views: video.views,
                    videoUrl: video.videoUrl,
                  })),
                  researchNotes: [
                    "The target video is excluded from its own baseline.",
                    "Only uploads published before the target video are considered.",
                    "Only comparable videos meeting the minimum age are included.",
                    "The baseline uses the median of comparable video views, not the average.",
                    "Videos of different duration-based formats are not mixed.",
                    "Five or more comparable uploads are required before an outlier multiplier is reported.",
                    "Confidence labels are based on sample size and are not statistical certainty.",
                    "Videos of 180 seconds or less are treated as potential Shorts. The YouTube Data API does not provide aspect ratio here, so this is not definitive Shorts classification.",
                    "The analysis uses publicly available view counts, which can change over time.",
                    "The detector checks up to 1,000 uploads in the channel's public uploads playlist.",
                  ],
                  playlistPagesChecked: pagesChecked,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "An unexpected error occurred while analyzing the video."
        );
      }
    }
  );
	

              description,
              publishedAt,
              publishedTime:
                publishedDate.getTime(),
              publishedHourUTC:
                publishedDate.getUTCHours(),
              publishedDayUTC:
                publishedDate.getUTCDay(),
              durationSeconds,
              views,
              likes,
              comments,
              engagementRate,
              relevanceScore: relevance.score,
              matchedQueryTerms:
                relevance.directMatches,
              matchedRelatedTerms:
                relevance.relatedMatches,
              videoUrl:
                `https://www.youtube.com/watch?v=${video.id}`,
              thumbnail:
                video.snippet?.thumbnails?.high?.url ??
                video.snippet?.thumbnails?.medium?.url ??
                video.snippet?.thumbnails?.default?.url ??
                null,
            });
          }
        } 
     });

  // TOOL 8: UNIVERSAL CONTENT PATTERN DETECTOR — VERSION 1.0.0
  server.registerTool(
    "youtube_content_pattern_detector",
    {
      description:
        "Discover and rank small YouTube competitors by topic relevance, analyze Shorts and long-form patterns separately, and identify channel-relative outliers with evidence safeguards.",

      inputSchema: z.object({
        query: z.string().min(2).max(100)
          .default("visual riddles brain teasers")
          .describe("Topic used to discover competitors and score upload relevance"),

        maxSubscribers: z.number().int().min(1).max(10000000)
          .default(50000),

        maxCompetitors: z.number().int().min(1).max(10)
          .default(10),

        contentType: z.enum(["shorts", "long_form", "both"])
          .default("both"),

        maxVideosPerChannel: z.number().int().min(5).max(50)
          .default(30),

        minimumAgeDays: z.number().int().min(0).max(365)
          .default(7),

        lookbackDays: z.number().int().min(7).max(730)
          .default(180),

        minimumRelevanceScore: z.number().min(1).max(10)
          .default(2)
          .describe("Minimum relevance score required for analysis"),
      }),
    },

    async ({
      query,
      maxSubscribers,
      maxCompetitors,
      contentType,
      maxVideosPerChannel,
      minimumAgeDays,
      lookbackDays,
      minimumRelevanceScore,
    }) => {
      try {
        const accessToken = await getGoogleAccessToken();
        const headers = {
          Authorization: `Bearer ${accessToken}`,
        };

        const now = Date.now();
        const dayMs = 24 * 60 * 60 * 1000;
        const minimumAgeMs = minimumAgeDays * dayMs;
        const lookbackMs = lookbackDays * dayMs;
        const oldestAllowedDate = new Date(now - lookbackMs);

        // --------------------------------------------------
        // 1. TOPIC CLASSIFICATION AND KEYWORD EXPANSION
        // --------------------------------------------------

        const normalize = (value: string): string =>
          value.toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim();

        const stopWords = new Set([
          "the", "and", "for", "you", "your", "are",
          "this", "that", "with", "from", "have", "has",
          "how", "what", "when", "why", "who", "can",
          "will", "was", "were", "not", "but", "all",
          "one", "two", "into", "its", "is", "a", "an",
          "to", "of", "in", "on", "at", "or", "by",
          "as", "be", "it", "me", "my", "do",
        ]);

        const words = (value: string): string[] =>
          normalize(value).split(" ").filter(
            (word) => word.length >= 2 && !stopWords.has(word)
          );

        const queryWords = words(query);
        const querySet = new Set(queryWords);

        const topicProfiles: Record<string, string[]> = {
          visual_riddles: [
            "visual riddle", "picture riddle", "visual puzzle",
            "brain teaser", "brain teasers", "picture puzzle",
            "observation test", "visual test",
          ],
          spot_the_difference: [
            "spot the difference", "find the difference",
            "find differences", "difference puzzle",
            "picture differences", "hidden difference",
          ],
          hidden_object: [
            "hidden object", "find the object", "hidden objects",
            "find hidden", "find the hidden", "seek and find",
            "hidden picture",
          ],
          logic_riddles: [
            "logic riddle", "logic puzzle", "tricky riddle",
            "brain test", "iq test", "who is lying",
            "who is the killer", "detective puzzle",
          ],
          math_puzzles: [
            "math puzzle", "maths puzzle", "number puzzle",
            "math riddle", "equation puzzle", "number riddle",
          ],
          general_quiz: [
            "quiz", "trivia", "general knowledge",
            "guess the", "knowledge test",
          ],
        };

        const profileMatches = Object.entries(topicProfiles)
          .map(([name, phrases]) => ({
            name,
            matches: phrases.filter((phrase) =>
              normalize(query).includes(normalize(phrase))
            ),
          }))
          .filter((item) => item.matches.length > 0)
          .sort((a, b) => b.matches.length - a.matches.length);

        const topicCategory =
          profileMatches[0]?.name ?? "custom_topic";

        const relatedGroups: Record<string, string[]> = {
          riddle_family: [
            "riddle", "riddles", "puzzle", "puzzles",
            "brainteaser", "brainteasers", "teaser", "teasers",
          ],
          visual_family: [
            "visual", "spot", "difference", "differences",
            "hidden", "find", "picture", "optical",
            "observation", "image",
          ],
          logic_family: [
            "quiz", "iq", "logic", "solve", "solution",
            "mystery", "detective", "reasoning", "clue",
          ],
          math_family: [
            "math", "maths", "equation", "number",
            "numbers", "calculation",
          ],
          object_family: [
            "object", "objects", "hidden", "seek",
            "search", "find", "picture",
          ],
        };

        const expandedTerms = new Set<string>(queryWords);

        for (const group of Object.values(relatedGroups)) {
          if (group.some((term) => querySet.has(term))) {
            group.forEach((term) => expandedTerms.add(term));
          }
        }

        for (const profile of profileMatches) {
          for (const phrase of profile.matches) {
            words(phrase).forEach((term) => expandedTerms.add(term));
          }
        }

        const queryPhrases = [
          normalize(query),
          ...profileMatches.flatMap((profile) => profile.matches.map(normalize)),
        ];

        // --------------------------------------------------
        // 2. RELEVANCE SCORING
        // --------------------------------------------------

        const scoreRelevance = (title: string, description: string) => {
          const normalizedTitle = normalize(title);
          const normalizedDescription = normalize(description);
          const titleWords = new Set(words(title));
          const descriptionWords = new Set(words(description));

          const directMatches = queryWords.filter(
            (term) => titleWords.has(term) || descriptionWords.has(term)
          );

          const titleDirectMatches = queryWords.filter(
            (term) => titleWords.has(term)
          );

          const relatedMatches = [...expandedTerms].filter(
            (term) =>
              !querySet.has(term) &&
              (titleWords.has(term) || descriptionWords.has(term))
          );

          const titleRelatedMatches = [...expandedTerms].filter(
            (term) => !querySet.has(term) && titleWords.has(term)
          );

          const phraseMatches = queryPhrases.filter(
            (phrase) =>
              phrase.length >= 5 &&
              normalizedTitle.includes(phrase)
          );

          const score =
            titleDirectMatches.length * 2 +
            (directMatches.length - titleDirectMatches.length) * 0.75 +
            titleRelatedMatches.length * 1.25 +
            (relatedMatches.length - titleRelatedMatches.length) * 0.35 +
            phraseMatches.length * 2;

          return {
            score: Math.round(Math.min(10, score) * 100) / 100,
            directMatches,
            relatedMatches,
            phraseMatches,
            relevant: score >= minimumRelevanceScore,
          };
        };

        // --------------------------------------------------
        // 3. DISCOVER CANDIDATE CHANNELS
        // --------------------------------------------------

        const searchUrl = new URL(
          "https://www.googleapis.com/youtube/v3/search"
        );

        searchUrl.searchParams.set("part", "snippet");
        searchUrl.searchParams.set("type", "video");
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("order", "viewCount");
        searchUrl.searchParams.set("maxResults", "50");
        searchUrl.searchParams.set(
          "publishedAfter",
          oldestAllowedDate.toISOString()
        );

        const searchResponse = await fetch(searchUrl, { headers });

        if (!searchResponse.ok) {
          return errorResult(
            `YouTube search failed: ${searchResponse.status}`
          );
        }

        const searchData: any = await searchResponse.json();
        const searchItems = searchData.items ?? [];

        if (searchItems.length === 0) {
          return errorResult(
            "No recent public videos were found. Try a broader query or a longer lookback period."
          );
        }

        const discoveredChannelIds = Array.from(
          new Set(
            searchItems
              .map((item: any) => item.snippet?.channelId)
              .filter(
                (id: any): id is string =>
                  typeof id === "string" && id.length > 0
              )
          )
        );

        // Limit candidate channels to keep API usage bounded.
        const candidateChannelIds = discoveredChannelIds.slice(0, 25);

        const channelDetails: any[] = [];

        for (let i = 0; i < candidateChannelIds.length; i += 50) {
          const batch = candidateChannelIds.slice(i, i + 50);
          const url = new URL(
            "https://www.googleapis.com/youtube/v3/channels"
          );

          url.searchParams.set("part", "snippet,statistics,contentDetails");
          url.searchParams.set("id", batch.join(","));

          const response = await fetch(url, { headers });

          if (!response.ok) {
            return errorResult(
              `YouTube channel lookup failed: ${response.status}`
            );
          }

          const data: any = await response.json();
          channelDetails.push(...(data.items ?? []));
        }

        const eligibleChannels = channelDetails.filter((channel) => {
          const stats = channel.statistics ?? {};

          if (
            stats.hiddenSubscriberCount === true ||
            stats.subscriberCount === undefined
          ) {
            return false;
          }

          const subscribers = Number(stats.subscriberCount);

          return Number.isFinite(subscribers) &&
            subscribers <= maxSubscribers;
        });

        if (eligibleChannels.length === 0) {
          return errorResult(
            "No eligible channels were found under the subscriber limit."
          );
        }

        // --------------------------------------------------
        // 4. RETRIEVE UPLOADS BEFORE RANKING COMPETITORS
        // --------------------------------------------------

        const candidateUploads: any[] = [];

        for (const channel of eligibleChannels) {
          const channelId = channel.id;
          const channelTitle = channel.snippet?.title ?? "Unknown channel";
          const subscribers = Number(channel.statistics?.subscriberCount ?? 0);
          const playlistId =
            channel.contentDetails?.relatedPlaylists?.uploads;

          if (!playlistId) {
            candidateUploads.push({
              channelId,
              channelTitle,
              subscribers,
              error: "Uploads playlist unavailable",
              videos: [],
            });
            continue;
          }

          const playlistUrl = new URL(
            "https://www.googleapis.com/youtube/v3/playlistItems"
          );

          playlistUrl.searchParams.set("part", "contentDetails");
          playlistUrl.searchParams.set("playlistId", playlistId);
          playlistUrl.searchParams.set(
            "maxResults",
            String(maxVideosPerChannel)
          );

          const playlistResponse = await fetch(playlistUrl, { headers });

          if (!playlistResponse.ok) {
            candidateUploads.push({
              channelId,
              channelTitle,
              subscribers,
              error: `Upload history request failed: ${playlistResponse.status}`,
              videos: [],
            });
            continue;
          }

          const playlistData: any = await playlistResponse.json();

          const videoIds = (playlistData.items ?? [])
            .map((item: any) => item.contentDetails?.videoId)
            .filter(
              (id: any): id is string =>
                typeof id === "string" && id.length > 0
            );

          const videoDetails: any[] = [];

          for (let i = 0; i < videoIds.length; i += 50) {
            const batch = videoIds.slice(i, i + 50);
            if (batch.length === 0) continue;

            const videosUrl = new URL(
              "https://www.googleapis.com/youtube/v3/videos"
            );

            videosUrl.searchParams.set(
              "part",
              "snippet,statistics,contentDetails"
            );
            videosUrl.searchParams.set("id", batch.join(","));

            const videosResponse = await fetch(videosUrl, { headers });

            if (!videosResponse.ok) continue;

            const videosData: any = await videosResponse.json();
            videoDetails.push(...(videosData.items ?? []));
          }

          candidateUploads.push({
            channelId,
            channelTitle,
            subscribers,
            videos: videoDetails,
          });
        }

        // --------------------------------------------------
        // 5. APPLY DATE AND RELEVANCE FILTERS
        // --------------------------------------------------

        let videosExcludedByAge = 0;
        let videosExcludedByRelevance = 0;
        let videosExcludedMissingDate = 0;
        let videosExcludedUnavailable = 0;

        const analyzedCandidates: any[] = [];

        for (const channel of candidateUploads) {
          const eligibleVideos: any[] = [];

          for (const video of channel.videos) {
            const publishedAt = video.snippet?.publishedAt;

            if (!publishedAt) {
              videosExcludedMissingDate++;
              continue;
            }

            const publishedDate = new Date(publishedAt);

            if (Number.isNaN(publishedDate.getTime())) {
              videosExcludedMissingDate++;
              continue;
            }

            const ageMs = now - publishedDate.getTime();

            if (ageMs < minimumAgeMs || ageMs > lookbackMs) {
              videosExcludedByAge++;
              continue;
            }

            const title = video.snippet?.title ?? "Untitled";
            const description = video.snippet?.description ?? "";
            const relevance = scoreRelevance(title, description);

            if (!relevance.relevant) {
              videosExcludedByRelevance++;
              continue;
            }

            const durationSeconds = durationToSeconds(
              video.contentDetails?.duration
            );

            const stats = video.statistics ?? {};
            const views = Number(stats.viewCount ?? 0);

            const likes =
              stats.likeCount !== undefined
                ? Number(stats.likeCount)
                : null;

            const comments =
              stats.commentCount !== undefined
                ? Number(stats.commentCount)
                : null;

            let engagementRate: number | null = null;

            if (
              views > 0 &&
              likes !== null &&
              comments !== null
            ) {
              engagementRate = ((likes + comments) / views) * 100;
            }

            eligibleVideos.push({
              videoId: video.id,
              title,
              description,
              publishedAt,
              publishedTime: publishedDate.getTime(),
              publishedHourUTC: publishedDate.getUTCHours(),
              publishedDayUTC: publishedDate.getUTCDay(),
              durationSeconds,
              views,
              likes,
              comments,
              engagementRate,
              relevanceScore: relevance.score,
              matchedQueryTerms: relevance.directMatches,
              matchedRelatedTerms: relevance.relatedMatches,
              matchedPhrases: relevance.phraseMatches,
              videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
              thumbnail:
                video.snippet?.thumbnails?.high?.url ??
                video.snippet?.thumbnails?.medium?.url ??
                video.snippet?.thumbnails?.default?.url ??
                null,
            });
          }

          const relevanceAverage =
            eligibleVideos.length > 0
              ? eligibleVideos.reduce(
                  (sum, video) => sum + video.relevanceScore,
                  0
                ) / eligibleVideos.length
              : 0;

          analyzedCandidates.push({
            channelId: channel.channelId,
            channelTitle: channel.channelTitle,
            subscribers: channel.subscribers,
            error: channel.error ?? null,
            videos: eligibleVideos,
            relevantUploadCount: eligibleVideos.length,
            averageRelevanceScore:
              Math.round(relevanceAverage * 100) / 100,
            relevanceRate:
              channel.videos.length > 0
                ? Math.round(
                    (eligibleVideos.length / channel.videos.length) * 10000
                  ) / 100
                : 0,
          });
        }

        // --------------------------------------------------
        // 6. RANK COMPETITORS BY RELEVANT EVIDENCE
        // --------------------------------------------------

        const rankedCandidates = analyzedCandidates
          .filter((channel) => channel.videos.length > 0)
          .sort((a, b) => {
            if (b.relevantUploadCount !== a.relevantUploadCount) {
              return b.relevantUploadCount - a.relevantUploadCount;
            }

            if (b.relevanceRate !== a.relevanceRate) {
              return b.relevanceRate - a.relevanceRate;
            }

            return b.averageRelevanceScore - a.averageRelevanceScore;
          });

        const selectedChannels = rankedCandidates.slice(0, maxCompetitors);

        if (selectedChannels.length === 0) {
          return errorResult(
            "No videos passed the age and relevance filters. Try a broader query or lower the minimum relevance score."
          );
        }

        const allVideos = selectedChannels.flatMap((channel) =>
          channel.videos.map((video: any) => ({
            ...video,
            channelId: channel.channelId,
            channelTitle: channel.channelTitle,
            subscribers: channel.subscribers,
          }))
        );

        const shortVideos = allVideos.filter(
          (video) => video.durationSeconds <= 180
        );

        const longVideos = allVideos.filter(
          (video) => video.durationSeconds > 180
        );

        // --------------------------------------------------
        // 7. CHANNEL-RELATIVE OUTLIER DETECTION
        // --------------------------------------------------

        const detectOutliers = (videos: any[]) => {
          const byChannel: Record<string, any[]> = {};

          for (const video of videos) {
            const key = video.channelId;
            if (!byChannel[key]) byChannel[key] = [];
            byChannel[key].push(video);
          }

          const results: any[] = [];

          for (const [channelId, channelVideos] of Object.entries(byChannel)) {
            const sortedByViews = [...channelVideos].sort(
              (a, b) => a.views - b.views
            );

            const channelMedian = median(
              sortedByViews.map((video) => video.views)
            );

            for (const video of channelVideos) {
              const baselineVideos = channelVideos.filter(
                (other) => other.videoId !== video.videoId
              );

              const baselineMedian = median(
                baselineVideos.map((other) => other.views)
              );

              const sampleSize = baselineVideos.length;

              let multiplier: number | null = null;
              let label = "Insufficient data";
              let confidence = "Insufficient data";

              if (sampleSize >= 5 && baselineMedian > 0) {
                multiplier = Math.round(
                  (video.views / baselineMedian) * 100
                ) / 100;

                confidence =
                  sampleSize >= 20
                    ? "High"
                    : sampleSize >= 10
                      ? "Medium"
                      : "Low";

                label =
                  multiplier >= 5
                    ? "Strong outlier"
                    : multiplier >= 2
                      ? "Potential outlier"
                      : multiplier >= 1
                        ? "At or above baseline"
                        : "Below baseline";
              }

              results.push({
                videoId: video.videoId,
                title: video.title,
                channelTitle: video.channelTitle,
                channelId,
                subscribers: video.subscribers,
                views: video.views,
                channelMedianViews: channelMedian,
                comparisonMedianViews: baselineMedian,
                comparisonSampleSize: sampleSize,
                outlierMultiplier: multiplier,
                performanceLabel: label,
                confidence,
                relevanceScore: video.relevanceScore,
                publishedAt: video.publishedAt,
                durationSeconds: video.durationSeconds,
                videoUrl: video.videoUrl,
              });
            }
          }

          return results.sort(
            (a, b) => (b.outlierMultiplier ?? 0) - (a.outlierMultiplier ?? 0)
          );
        };

        // --------------------------------------------------
        // 8. FORMAT ANALYSIS AND EVIDENCE SAFEGUARDS
        // --------------------------------------------------

        const analyzeFormat = (
          videos: any[],
          formatName: string
        ) => {
          if (videos.length === 0) {
            return {
              format: formatName,
              videosAnalyzed: 0,
              evidenceStatus: "No evidence",
              message: "No videos passed the selected filters.",
              outliers: [],
            };
          }

          const views = videos.map((video) => video.views);
          const durations = videos.map((video) => video.durationSeconds);

          const engagementValues = videos
            .map((video) => video.engagementRate)
            .filter(
              (value: any): value is number =>
                typeof value === "number" && Number.isFinite(value)
            );

          const totalViews = views.reduce((sum, value) => sum + value, 0);

          const averageEngagement =
            engagementValues.length > 0
              ? engagementValues.reduce((sum, value) => sum + value, 0) /
                engagementValues.length
              : null;

          const wordCounts: Record<string, number> = {};

          for (const video of videos) {
            for (const word of new Set(words(video.title))) {
              wordCounts[word] = (wordCounts[word] ?? 0) + 1;
            }
          }

          const recurringWords = Object.entries(wordCounts)
            .filter(([, count]) => count >= 2)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([word, appearances]) => ({ word, appearances }));

          const questionCount = videos.filter(
            (video) => video.title.includes("?")
          ).length;

          const hashtagCount = videos.filter(
            (video) => /#[a-z0-9_]+/i.test(video.title)
          ).length;

          const numberCount = videos.filter(
            (video) => /\d/.test(video.title)
          ).length;

          const durationBuckets: Record<string, number> =
            formatName === "Shorts"
              ? {
                  "0–15 seconds": 0,
                  "16–30 seconds": 0,
                  "31–60 seconds": 0,
                  "61–90 seconds": 0,
                  "91–180 seconds": 0,
                }
              : {
                  "181–300 seconds": 0,
                  "301–600 seconds": 0,
                  "601–1200 seconds": 0,
                  "1201–1800 seconds": 0,
                  "Over 1800 seconds": 0,
                };

          for (const duration of durations) {
            if (formatName === "Shorts") {
              if (duration <= 15) durationBuckets["0–15 seconds"]++;
              else if (duration <= 30) durationBuckets["16–30 seconds"]++;
              else if (duration <= 60) durationBuckets["31–60 seconds"]++;
              else if (duration <= 90) durationBuckets["61–90 seconds"]++;
              else durationBuckets["91–180 seconds"]++;
            } else {
              if (duration <= 300) durationBuckets["181–300 seconds"]++;
              else if (duration <= 600) durationBuckets["301–600 seconds"]++;
              else if (duration <= 1200) durationBuckets["601–1200 seconds"]++;
              else if (duration <= 1800) durationBuckets["1201–1800 seconds"]++;
              else durationBuckets["Over 1800 seconds"]++;
            }
          }

          const hourCounts: Record<string, number> = {};
          const dayCounts: Record<string, number> = {};

          const dayNames = [
            "Sunday", "Monday", "Tuesday", "Wednesday",
            "Thursday", "Friday", "Saturday",
          ];

          for (const video of videos) {
            const hour = `${String(video.publishedHourUTC).padStart(2, "0")}:00 UTC`;
            hourCounts[hour] = (hourCounts[hour] ?? 0) + 1;

            const day = dayNames[video.publishedDayUTC];
            dayCounts[day] = (dayCounts[day] ?? 0) + 1;
          }

          const outliers = detectOutliers(videos);

          const outlierSummary = {
            strongOutliers: outliers.filter(
              (item) => item.performanceLabel === "Strong outlier"
            ).length,
            potentialOutliers: outliers.filter(
              (item) => item.performanceLabel === "Potential outlier"
            ).length,
            insufficientData: outliers.filter(
              (item) => item.performanceLabel === "Insufficient data"
            ).length,
          };

          const evidenceStatus =
            videos.length >= 30
              ? "Good sample"
              : videos.length >= 10
                ? "Limited sample"
                : "Small sample";

          return {
            format: formatName,
            videosAnalyzed: videos.length,
            evidenceStatus,
            totalViews,
            averageViews: Math.round(totalViews / videos.length),
            medianViews: median(views),
            averageEngagementRate:
              averageEngagement === null
                ? null
                : Math.round(averageEngagement * 100) / 100,
            videosWithEngagementData: engagementValues.length,
            averageDurationSeconds: Math.round(
              durations.reduce((sum, value) => sum + value, 0) /
                durations.length
            ),
            medianDurationSeconds: median(durations),

            titlePatterns: {
              questionTitles: {
                count: questionCount,
                percentage: percentage(questionCount, videos.length),
              },
              hashtagTitles: {
                count: hashtagCount,
                percentage: percentage(hashtagCount, videos.length),
              },
              titlesContainingNumbers: {
                count: numberCount,
                percentage: percentage(numberCount, videos.length),
              },
              recurringWords,
            },

            durationDistribution: durationBuckets,

            publishingPatterns: {
              busiestHoursUTC: Object.entries(hourCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([hour, uploads]) => ({ hour, uploads })),

              busiestDaysUTC: Object.entries(dayCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([day, uploads]) => ({ day, uploads })),
            },

            outlierSummary,

            topVideos: [...videos]
              .sort((a, b) => b.views - a.views)
              .slice(0, 10)
              .map((video) => ({
                title: video.title,
                channelTitle: video.channelTitle,
                subscribers: video.subscribers,
                views: video.views,
                durationSeconds: video.durationSeconds,
                publishedAt: video.publishedAt,
                relevanceScore: video.relevanceScore,
                matchedQueryTerms: video.matchedQueryTerms,
                matchedRelatedTerms: video.matchedRelatedTerms,
                engagementRate:
                  video.engagementRate === null
                    ? null
                    : Math.round(video.engagementRate * 100) / 100,
                videoUrl: video.videoUrl,
                thumbnail: video.thumbnail,
              })),

            outliers: outliers.slice(0, 20),
          };
        };

        // --------------------------------------------------
        // 9. BUILD FORMAT-SPECIFIC REPORTS
        // --------------------------------------------------

        const reports: Record<string, unknown> = {};

        if (contentType === "shorts" || contentType === "both") {
          reports.shorts = analyzeFormat(shortVideos, "Shorts");
        }

        if (contentType === "long_form" || contentType === "both") {
          reports.longForm = analyzeFormat(longVideos, "Long-form");
        }

        // --------------------------------------------------
        // 10. BUILD COMPETITOR QUALITY RANKINGS
        // --------------------------------------------------

        const competitors = selectedChannels.map((channel, index) => ({
          rank: index + 1,
          channelTitle: channel.channelTitle,
          channelId: channel.channelId,
          subscribers: channel.subscribers,
          relevantUploads: channel.relevantUploadCount,
          relevanceRate: channel.relevanceRate,
          averageRelevanceScore: channel.averageRelevanceScore,
          channelUrl: `https://www.youtube.com/channel/${channel.channelId}`,
          rankingBasis:
            "Relevant upload count, relevance rate, then average relevance score",
        }));

        // --------------------------------------------------
        // 11. RETURN RESULTS AND TRANSPARENT LIMITATIONS
        // --------------------------------------------------

        const selectedCandidateIds = new Set(
          selectedChannels.map((channel) => channel.channelId)
        );

        const excludedCandidateChannels = analyzedCandidates
          .filter((channel) => !selectedCandidateIds.has(channel.channelId))
          .map((channel) => ({
            channelTitle: channel.channelTitle,
            channelId: channel.channelId,
            relevantUploads: channel.relevantUploadCount,
            reason:
              channel.error ??
              (channel.videos.length === 0
                ? "No uploads passed relevance and date filters"
                : "Ranked below the selected competitor limit"),
          }));

        const totalVideosRetrieved = candidateUploads.reduce(
          (sum, channel) => sum + channel.videos.length,
          0
        );

        const totalVideosExcluded =
          videosExcludedByAge +
          videosExcludedByRelevance +
          videosExcludedMissingDate;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  tool: "youtube_content_pattern_detector",
                  version: "1.0.0",
                  searchTopic: query,
                  topicClassification: {
                    category: topicCategory,
                    matchedTopicProfiles: profileMatches.map(
                      (profile) => ({
                        category: profile.name,
                        matchedPhrases: profile.matches,
                      })
                    ),
                    expandedVocabulary: [...expandedTerms],
                  },

                  filters: {
                    maximumSubscribers: maxSubscribers,
                    maximumCompetitors: maxCompetitors,
                    contentType,
                    maximumVideosPerChannel: maxVideosPerChannel,
                    minimumAgeDays,
                    lookbackDays,
                    minimumRelevanceScore,
                  },

                  discovery: {
                    searchResultsRetrieved: searchItems.length,
                    uniqueChannelsDiscovered: discoveredChannelIds.length,
                    candidateChannelsInspected: candidateChannelIds.length,
                    eligibleChannelsFound: eligibleChannels.length,
                    channelsWithUploads: candidateUploads.filter(
                      (channel) => !channel.error && channel.videos.length > 0
                    ).length,
                    channelsRanked: rankedCandidates.length,
                    channelsSelected: selectedChannels.length,
                    videosRetrieved: totalVideosRetrieved,
                    eligibleVideosAnalyzed: allVideos.length,
                    videosExcludedByAge,
                    videosExcludedByRelevance,
                    videosExcludedMissingDate,
                    totalVideosExcluded,
                  },

                  competitors,
                  excludedCandidateChannels,
                  reports,

                  methodology: {
                    relevanceScoring:
                      "Title matches receive more weight than description matches. Exact query phrases and related vocabulary add additional points. Scores are capped at 10.",
                    competitorRanking:
                      "Channels are ranked after upload analysis by relevant upload count, relevance rate, and average relevance score.",
                    outlierMethod:
                      "Each video is compared with the median views of other eligible videos from the same channel and same format. The target video is excluded from its own baseline.",
                    outlierThresholds: {
                      strongOutlier: "5x or more than channel median",
                      potentialOutlier: "2x to less than 5x channel median",
                      atOrAboveBaseline: "1x to less than 2x channel median",
                      belowBaseline: "Less than 1x channel median",
                      minimumComparisonVideos: 5,
                    },
                    confidenceHeuristic: {
                      low: "5–9 comparison videos",
                      medium: "10–19 comparison videos",
                      high: "20 or more comparison videos",
                      note:
                        "Confidence labels reflect sample size only, not statistical certainty.",
                    },
                  },

                  researchNotes: [
                    "Topic classification is based on phrase matches in the supplied query. A custom query may be classified as custom_topic.",
                    "Relevance scoring uses keyword and phrase matching in video titles and descriptions. It is not semantic AI classification.",
                    "Competitor discovery is based on up to 50 recent search results ordered by public view count.",
                    "At most 25 discovered channels are inspected to bound API usage. This is not a complete census of the niche.",
                    "Competitors are ranked after their uploads are analyzed, rather than solely by their position in search results.",
                    "Only channels with publicly visible subscriber counts at or below the configured limit are included.",
                    "Only uploads inside the lookback window and older than the minimum age are analyzed.",
                    "Shorts and long-form videos are analyzed separately. Videos of 180 seconds or less are treated as potential Shorts; aspect ratio is not available, so this classification is not definitive.",
                    "Outlier comparisons use each channel's own median for the same format. A minimum of five other eligible videos is required.",
                    "Outlier confidence is a sample-size heuristic and is not a statistical confidence interval.",
                    "A small number of eligible videos can produce unstable averages and patterns. Check evidenceStatus before acting on a result.",
                    "Engagement rate is calculated only when public views, likes, and comments are available.",
                    "Publishing times and days are calculated in UTC.",
                    "Title patterns describe the sample and do not prove that a title structure caused higher views.",
                    "Top videos are ranked by public view count, not subscriber-adjusted performance.",
                    "This tool does not inspect actual video footage, audio, or thumbnail image content.",
                    "Public views and channel statistics can change over time.",
                    "Some uploads may be unavailable or omitted by YouTube's public API.",
                  ],
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "An unexpected error occurred while detecting content patterns."
        );
      }
    }
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


