
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
    version: "0.6.0",
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

    if (sorted.length % 2 === 0) {
      return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
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
        console.error("Channel analytics error:", error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error
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
        console.error("Video analytics error:", error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error
                ? error.message
                : "Unable to retrieve video analytics.",
            },
          ],
        };
      }
    },
  );

  // Tool 4: YouTube video metadata.
  server.registerTool(
    "youtube_video_metadata",
    {
      description:
        "Retrieve YouTube video titles, descriptions, publication dates, durations, thumbnails and video URLs for up to 50 video IDs. Also identifies potential Shorts based on duration.",
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
                    (id) => !videos.some((video) => video.videoId === id),
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
        console.error("Video metadata error:", error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error
                ? error.message
                : "Unable to retrieve video metadata.",
            },
          ],
        };
      }
    },
  );

  // Tool 5: Public YouTube video search.
  server.registerTool(
    "youtube_public_video_search",
    {
      description:
        "Search public YouTube videos by keyword. Retrieve video statistics and channel subscriber counts, and identify channels below a subscriber threshold.",
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

        const searchUrl = new URL(
          "https://www.googleapis.com/youtube/v3/search",
        );

        searchUrl.searchParams.set("part", "snippet");
        searchUrl.searchParams.set("type", "video");
        searchUrl.searchParams.set("q", query);
        searchUrl.searchParams.set("maxResults", String(maxResults));
        searchUrl.searchParams.set("order", order);

        const searchResponse = await fetch(searchUrl.toString(), {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
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
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
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

        const channelsUrl = new URL(
          "https://www.googleapis.com/youtube/v3/channels",
        );

        channelsUrl.searchParams.set("part", "snippet,statistics");
        channelsUrl.searchParams.set("id", channelIds.join(","));

        const channelsResponse = await fetch(channelsUrl.toString(), {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

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
              videoCount?: string;
            };
          }>;
        };

        const channelMap = new Map(
          (channelsData.items || []).map((channel) => [
            channel.id,
            channel,
          ]),
        );

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
            likes: video.statistics?.likeCount
              ? Number(video.statistics.likeCount)
              : null,
            comments: video.statistics?.commentCount
              ? Number(video.statistics.commentCount)
              : null,
            duration,
            durationSeconds,
            formatCandidate:
              durationSeconds !== null && durationSeconds <= 180
                ? "Potential Short — verify aspect ratio"
                : "Long-form candidate",
            isUnderSubscriberLimit:
              subscriberCount !== null &&
              subscriberCount < maxSubscribers,
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
                  searchResults: searchItems.length,
                  videosRetrieved: videos.length,
                  eligibleVideos: eligibleVideos.length,
                  source: "YouTube Data API v3",
                  note:
                    "Subscriber counts may be hidden. Duration alone cannot confirm whether a video is a Short; aspect ratio must also be checked.",
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
        console.error("Public video search error:", error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error
                ? error.message
                : "Unable to search public YouTube videos.",
            },
          ],
        };
      }
    },
  );

  // Tool 6: Public channel upload history and median-view baseline.
  server.registerTool(
    "youtube_channel_upload_history",
    {
      description:
        "Retrieve recent public uploads from up to 10 YouTube channels. Collect video statistics, durations and publication dates. Calculate separate median-view baselines for potential Shorts and long-form candidates using videos at least 7 days old.",
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

        // Step 1: Retrieve channel upload playlist IDs.
        const channelsUrl = new URL(
          "https://www.googleapis.com/youtube/v3/channels",
        );

        channelsUrl.searchParams.set("part", "snippet,contentDetails,statistics");
        channelsUrl.searchParams.set(
          "id",
          uniqueChannelIds.join(","),
        );

        const channelsResponse = await fetch(channelsUrl.toString(), {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

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

        // Step 2: Retrieve recent uploads from each channel.
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
                subscriberCount: channel.statistics?.subscriberCount
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

            playlistUrl.searchParams.set("part", "contentDetails,snippet");
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
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              },
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
              subscriberCount: channel.statistics?.subscriberCount
                ? Number(channel.statistics.subscriberCount)
                : null,
              hiddenSubscriberCount:
                channel.statistics?.hiddenSubscriberCount ?? false,
              error: null,
              uploads,
            };
          }),
        );

        // Step 3: Collect video IDs and retrieve video details in batches.
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

          const videosResponse = await fetch(videosUrl.toString(), {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
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
              likes: video.statistics?.likeCount
                ? Number(video.statistics.likeCount)
                : null,
              comments: video.statistics?.commentCount
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

        // Step 4: Build channel histories and separate baselines.
        const now = Date.now();
        const minimumAgeMs = minimumAgeDays * 24 * 60 * 60 * 1000;

        const results = channelResults.map((channel) => {
          const uploads = channel.uploads
            .map((upload) => {
              const video = videoMap.get(upload.videoId);
              if (!video) return null;

              const ageMs = now - new Date(video.publishedAt).getTime();
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
                oldEnoughForBaseline: ageMs >= minimumAgeMs,
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

          const shortMedianViews = median(
            potentialShorts.map((video) => video.views),
          );

          const longFormMedianViews = median(
            longForm.map((video) => video.views),
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
                medianViews: shortMedianViews,
              },
              longForm: {
                videosUsed: longForm.length,
                medianViews: longFormMedianViews,
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
        console.error("Channel upload history error:", error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error
                ? error.message
                : "Unable to retrieve channel upload history.",
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
