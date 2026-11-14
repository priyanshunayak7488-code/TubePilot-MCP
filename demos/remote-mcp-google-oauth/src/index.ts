
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
    version: "0.8.0",
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

  // Tool 7: Public YouTube outlier detector.
  server.registerTool(
    "youtube_video_outlier_detector",
    {
      description:
        "Analyze a public YouTube video against earlier uploads from the same channel. Excludes the target video, compares matching potential Shorts or long-form candidates, and calculates a views-to-median multiplier with sample-size confidence.",
      inputSchema: z.object({
        targetVideoId: z.string().min(1).max(20),
        maxBaselineUploads: z.number().int().min(5).max(50).default(30),
        minimumAgeDays: z.number().int().min(1).max(90).default(7),
        outlierThreshold: z.number().min(1).max(100).default(3),
      }),
    },
    async ({
      targetVideoId,
      maxBaselineUploads,
      minimumAgeDays,
      outlierThreshold,
    }) => {
      try {
        const accessToken = await getGoogleAccessToken();
        const headers = {
          Authorization: `Bearer ${accessToken}`,
        };

        // Step 1: Retrieve target video details.
        const targetUrl = new URL(
          "https://www.googleapis.com/youtube/v3/videos",
        );

        targetUrl.searchParams.set(
          "part",
          "snippet,statistics,contentDetails",
        );
        targetUrl.searchParams.set("id", targetVideoId);

        const targetResponse = await fetch(targetUrl.toString(), {
          headers,
        });

        if (!targetResponse.ok) {
          throw new Error(
            `Target video request failed (${targetResponse.status}): ${await targetResponse.text()}`,
          );
        }

        const targetData = await targetResponse.json() as {
          items?: Array<{
            id: string;
            snippet: {
              title: string;
              channelId: string;
              channelTitle: string;
              publishedAt: string;
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

        const target = targetData.items?.[0];

        if (!target) {
          throw new Error(
            "Target video was not found or is not publicly available.",
          );
        }

        const targetDurationSeconds = durationToSeconds(
          target.contentDetails?.duration || "",
        );

        const targetIsPotentialShort =
          targetDurationSeconds <= 180;

        const targetViews = Number(
          target.statistics?.viewCount || 0,
        );

        const targetPublishedAt = new Date(
          target.snippet.publishedAt,
        );

        if (
          !Number.isFinite(targetPublishedAt.getTime()) ||
          !Number.isFinite(targetViews)
        ) {
          throw new Error("Target video data is invalid.");
        }

        // Step 2: Retrieve the channel's uploads playlist.
        const channelUrl = new URL(
          "https://www.googleapis.com/youtube/v3/channels",
        );

        channelUrl.searchParams.set("part", "contentDetails");
        channelUrl.searchParams.set("id", target.snippet.channelId);

        const channelResponse = await fetch(channelUrl.toString(), {
          headers,
        });

        if (!channelResponse.ok) {
          throw new Error(
            `Channel request failed (${channelResponse.status}): ${await channelResponse.text()}`,
          );
        }

        const channelData = await channelResponse.json() as {
          items?: Array<{
            contentDetails?: {
              relatedPlaylists?: {
                uploads?: string;
              };
            };
          }>;
        };

        const uploadsPlaylistId =
          channelData.items?.[0]?.contentDetails
            ?.relatedPlaylists?.uploads;

        if (!uploadsPlaylistId) {
          throw new Error(
            "Could not retrieve the channel's public uploads playlist.",
          );
        }

        // Step 3: Page through uploads until the target is found.
        // YouTube allows a maximum of 50 playlist items per request.
        // The playlist is ordered newest to oldest.
        const baselineVideos: Array<{
          id: string;
          title: string;
          publishedAt: string;
          durationSeconds: number;
          views: number;
        }> = [];

        let pageToken: string | undefined;
        let targetFound = false;
        let pagesScanned = 0;

        const maximumPages = 20;
        const minimumAgeMs =
          minimumAgeDays * 24 * 60 * 60 * 1000;
        const now = Date.now();

        while (
          pagesScanned < maximumPages &&
          baselineVideos.length < maxBaselineUploads
        ) {
          const playlistUrl = new URL(
            "https://www.googleapis.com/youtube/v3/playlistItems",
          );

          playlistUrl.searchParams.set("part", "contentDetails");
          playlistUrl.searchParams.set(
            "playlistId",
            uploadsPlaylistId,
          );
          playlistUrl.searchParams.set("maxResults", "50");

          if (pageToken) {
            playlistUrl.searchParams.set("pageToken", pageToken);
          }

          const playlistResponse = await fetch(
            playlistUrl.toString(),
            { headers },
          );

          if (!playlistResponse.ok) {
            throw new Error(
              `Uploads playlist request failed (${playlistResponse.status}): ${await playlistResponse.text()}`,
            );
          }

          const playlistData = await playlistResponse.json() as {
            nextPageToken?: string;
            items?: Array<{
              contentDetails?: {
                videoId?: string;
              };
            }>;
          };

          pagesScanned++;

          const pageIds = (playlistData.items || [])
            .map((item) => item.contentDetails?.videoId)
            .filter((id): id is string => Boolean(id));

          let olderIds: string[];

          if (!targetFound) {
            const targetIndex = pageIds.indexOf(targetVideoId);

            if (targetIndex === -1) {
              olderIds = [];
            } else {
              targetFound = true;
              olderIds = pageIds.slice(targetIndex + 1);
            }
          } else {
            olderIds = pageIds;
          }

          // Step 4: Retrieve details for older uploads.
          const uniqueOlderIds = [
            ...new Set(olderIds),
          ].filter((id) => id !== targetVideoId);

          for (let i = 0; i < uniqueOlderIds.length; i += 50) {
            if (baselineVideos.length >= maxBaselineUploads) break;

            const batch = uniqueOlderIds.slice(i, i + 50);
            if (batch.length === 0) continue;

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
                `History videos request failed (${videosResponse.status}): ${await videosResponse.text()}`,
              );
            }

            const videosData = await videosResponse.json() as {
              items?: Array<{
                id: string;
                snippet: {
                  title: string;
                  publishedAt: string;
                };
                statistics?: {
                  viewCount?: string;
                };
                contentDetails?: {
                  duration?: string;
                };
              }>;
            };

            for (const video of videosData.items || []) {
              if (baselineVideos.length >= maxBaselineUploads) break;

              const publishedAt = new Date(
                video.snippet.publishedAt,
              ).getTime();

              if (!Number.isFinite(publishedAt)) continue;

              if (publishedAt >= targetPublishedAt.getTime()) {
                continue;
              }

              if (now - publishedAt < minimumAgeMs) {
                continue;
              }

              const durationSeconds = durationToSeconds(
                video.contentDetails?.duration || "",
              );

              const isPotentialShort = durationSeconds <= 180;

              if (isPotentialShort !== targetIsPotentialShort) {
                continue;
              }

              baselineVideos.push({
                id: video.id,
                title: video.snippet.title,
                publishedAt: video.snippet.publishedAt,
                durationSeconds,
                views: Number(
                  video.statistics?.viewCount || 0,
                ),
              });
            }
          }

          if (!playlistData.nextPageToken) break;

          pageToken = playlistData.nextPageToken;
        }

        if (!targetFound) {
          throw new Error(
            `Target video was not found in the channel's uploads playlist within ${maximumPages} pages. The video may not be part of the channel's public upload history.`,
          );
        }

        // Step 5: Calculate baseline and confidence.
        const comparableVideos = baselineVideos.slice(
          0,
          maxBaselineUploads,
        );

        const sampleSize = comparableVideos.length;

        const baselineViews = median(
          comparableVideos.map((video) => video.views),
        );

        let confidence:
          | "Insufficient data"
          | "Low"
          | "Medium"
          | "High";

        if (sampleSize < 5) {
          confidence = "Insufficient data";
        } else if (sampleSize <= 9) {
          confidence = "Low";
        } else if (sampleSize <= 19) {
          confidence = "Medium";
        } else {
          confidence = "High";
        }

        // No multiplier or outlier verdict with fewer than five samples.
        const multiplier =
          sampleSize >= 5 &&
          baselineViews !== null &&
          baselineViews > 0
            ? Number(
                (targetViews / baselineViews).toFixed(2),
              )
            : null;

        let performanceLabel: string;

        if (sampleSize < 5) {
          performanceLabel = "Insufficient data";
        } else if (multiplier === null) {
          performanceLabel =
            "Cannot calculate — baseline is zero or unavailable.";
        } else if (multiplier >= outlierThreshold) {
          performanceLabel = "Potential outlier";
        } else if (multiplier > 1) {
          performanceLabel = "Above channel baseline";
        } else if (multiplier === 1) {
          performanceLabel = "At channel baseline";
        } else {
          performanceLabel = "Below channel baseline";
        }

        const targetAgeDays = Math.max(
          0,
          Math.floor(
            (now - targetPublishedAt.getTime()) /
              (24 * 60 * 60 * 1000),
          ),
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  source: "YouTube Data API v3",
                  analysis: "Public channel outlier analysis",

                  channel: {
                    name: target.snippet.channelTitle,
                    channelId: target.snippet.channelId,
                    channelUrl:
                      `https://www.youtube.com/channel/${target.snippet.channelId}`,
                  },

                  targetVideo: {
                    videoId: target.id,
                    title: target.snippet.title,
                    publishedAt: target.snippet.publishedAt,
                    ageDays: targetAgeDays,
                    durationSeconds: targetDurationSeconds,
                    formatCandidate: targetIsPotentialShort
                      ? "Potential Short — verify aspect ratio"
                      : "Long-form candidate",
                    views: targetViews,
                    likes: target.statistics?.likeCount
                      ? Number(target.statistics.likeCount)
                      : null,
                    comments: target.statistics?.commentCount
                      ? Number(target.statistics.commentCount)
                      : null,
                    videoUrl:
                      `https://www.youtube.com/watch?v=${target.id}`,
                  },

                  baseline: {
                    method:
                      "Median views of earlier, mature uploads from the same channel and format candidate.",
                    targetExcluded: true,
                    minimumAgeDays,
                    requestedMaximum: maxBaselineUploads,
                    comparableVideosFound: sampleSize,
                    medianViews: baselineViews,
                    playlistPagesScanned: pagesScanned,
                    playlistPageLimit: maximumPages,
                  },

                  outlierAnalysis: {
                    targetViews,
                    baselineMedianViews: baselineViews,
                    outlierMultiplier: multiplier,
                    thresholdMultiplier: outlierThreshold,
                    performanceLabel,
                    confidence,
                    confidenceSampleSize: sampleSize,
                    scoreStatus:
                      sampleSize < 5
                        ? "Insufficient comparable uploads. No outlier verdict or multiplier has been issued."
                        : multiplier === null
                          ? "Baseline cannot support a multiplier."
                          : "Multiplier calculated from the available comparable uploads.",
                  },

                  comparableVideos,

                  notes: [
                    "The target must be found in the channel's public uploads playlist.",
                    "The target video is always excluded from its own baseline.",
                    "Only uploads published before the target are considered.",
                    "Only uploads at least the requested minimum age are used.",
                    "Potential Shorts and long-form candidates are compared separately.",
                    "Duration of 180 seconds or less is only a potential Short classification; aspect ratio is not verified.",
                    "The outlier threshold is configurable and defaults to 3x the channel median.",
                    "A confidence label describes sample size, not statistical certainty.",
                    "The detector scans up to 20 playlist pages to find the target and collect older comparable uploads.",
                    "The baseline includes up to the requested number of mature comparable uploads.",
                  ],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        console.error("Video outlier detector error:", error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error
                ? error.message
                : "Unable to analyze the video for outlier performance.",
            },
          ],
        };
      }
    },
  );
	
  // Tool 8: Universal Shorts and long-form content pattern detector.
  server.registerTool(
    "youtube_content_pattern_detector",
    {
      description:
        "Analyze public YouTube uploads to discover recurring content patterns. Choose shorts, long_form, or both. Reports format-specific performance, title structures, duration, publishing times, engagement and example videos. Shorts and long-form are always analyzed separately. Shorts are duration-based candidates because aspect ratio is not provided by the API.",
      inputSchema: z.object({
        channelIds: z.array(z.string().min(1)).min(1).max(10),
        contentType: z.enum(["shorts", "long_form", "both"]).default("both"),
        maxVideosPerChannel: z.number().int().min(5).max(50).default(30),
        minimumAgeDays: z.number().int().min(0).max(365).default(7),
        niche: z.string().max(100).optional(),
      }),
    },
    async ({
      channelIds,
      contentType,
      maxVideosPerChannel,
      minimumAgeDays,
      niche,
    }) => {
      try {
        const accessToken = await getGoogleAccessToken();
        const headers = {
          Authorization: `Bearer ${accessToken}`,
        };

        const uniqueChannelIds = [...new Set(channelIds)];
        const now = Date.now();
        const minimumAgeMs =
          minimumAgeDays * 24 * 60 * 60 * 1000;

        // Retrieve channel information and uploads playlist IDs.
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
            `Channels API returned ${channelsResponse.status}: ${await channelsResponse.text()}`,
          );
        }

        const channelsData = await channelsResponse.json() as {
          items?: Array<{
            id: string;
            snippet?: { title?: string };
            contentDetails?: {
              relatedPlaylists?: { uploads?: string };
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

        // Retrieve recent public uploads for each channel.
        const channelUploads = await Promise.all(
          uniqueChannelIds.map(async (channelId) => {
            const channel = channelMap.get(channelId);

            if (!channel) {
              return {
                channelId,
                channelTitle: null,
                subscriberCount: null,
                uploads: [] as string[],
                error: "Channel not found or unavailable.",
              };
            }

            const playlistId =
              channel.contentDetails?.relatedPlaylists?.uploads;

            if (!playlistId) {
              return {
                channelId,
                channelTitle: channel.snippet?.title || null,
                subscriberCount: null,
                uploads: [] as string[],
                error: "Uploads playlist unavailable.",
              };
            }

            const playlistUrl = new URL(
              "https://www.googleapis.com/youtube/v3/playlistItems",
            );

            playlistUrl.searchParams.set(
              "part",
              "contentDetails",
            );
            playlistUrl.searchParams.set(
              "playlistId",
              playlistId,
            );
            playlistUrl.searchParams.set(
              "maxResults",
              String(maxVideosPerChannel),
            );

            const playlistResponse = await fetch(
              playlistUrl.toString(),
              { headers },
            );

            if (!playlistResponse.ok) {
              throw new Error(
                `Playlist API returned ${playlistResponse.status} for ${channelId}: ${await playlistResponse.text()}`,
              );
            }

            const playlistData = await playlistResponse.json() as {
              items?: Array<{
                contentDetails?: { videoId?: string };
              }>;
            };

            return {
              channelId,
              channelTitle: channel.snippet?.title || null,
              subscriberCount:
                channel.statistics?.subscriberCount !== undefined
                  ? Number(channel.statistics.subscriberCount)
                  : null,
              uploads: (playlistData.items || [])
                .map((item) => item.contentDetails?.videoId || "")
                .filter(Boolean),
              error: null,
            };
          }),
        );

        const allVideoIds = [
          ...new Set(
            channelUploads.flatMap((channel) => channel.uploads),
          ),
        ];

        // Retrieve video details in batches of 50.
        const videoMap = new Map<
          string,
          {
            videoId: string;
            title: string;
            description: string;
            publishedAt: string;
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
              `Videos API returned ${videosResponse.status}: ${await videosResponse.text()}`,
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
            const durationSeconds = durationToSeconds(
              video.contentDetails?.duration || "",
            );

            videoMap.set(video.id, {
              videoId: video.id,
              title: video.snippet.title,
              description: video.snippet.description,
              publishedAt: video.snippet.publishedAt,
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

        // Build a video collection for each channel.
        const videosByChannel = channelUploads.map((channel) => {
          const videos = channel.uploads
            .map((id) => videoMap.get(id))
            .filter((video) => video !== undefined)
            .filter((video) => {
              const publishedTime = new Date(
                video.publishedAt,
              ).getTime();

              return (
                Number.isFinite(publishedTime) &&
                now - publishedTime >= minimumAgeMs
              );
            })
            .map((video) => ({
              ...video,
              ageDays: Math.floor(
                (now - new Date(video.publishedAt).getTime()) /
                  (24 * 60 * 60 * 1000),
              ),
              formatCandidate:
                video.durationSeconds <= 180
                  ? "Potential Short — verify aspect ratio"
                  : "Long-form candidate",
            }));

          return {
            channelId: channel.channelId,
            channelTitle: channel.channelTitle,
            subscriberCount: channel.subscriberCount,
            error: channel.error,
            videos,
          };
        });

        // Aggregate patterns separately for each requested format.
        function analyzeFormat(
          format: "shorts" | "long_form",
        ) {
          const selectedVideos = videosByChannel.flatMap(
            (channel) =>
              channel.videos
                .filter((video) =>
                  format === "shorts"
                    ? video.durationSeconds <= 180
                    : video.durationSeconds > 180,
                )
                .map((video) => ({
                  ...video,
                  channelId: channel.channelId,
                  channelTitle: channel.channelTitle,
                })),
          );

          const sortedViews = selectedVideos
            .map((video) => video.views)
            .sort((a, b) => a - b);

          const medianViews = median(sortedViews);

          const averageViews = selectedVideos.length
            ? Math.round(
                sortedViews.reduce((sum, value) => sum + value, 0) /
                  sortedViews.length,
              )
            : null;

          const durationMedian = median(
            selectedVideos.map((video) => video.durationSeconds),
          );

          const titleWords = new Map<string, number>();
          let questionTitles = 0;
          let hashtagTitles = 0;
          let titlesWithNumbers = 0;

          const publishingHours = new Map<number, number>();
          const publishingDays = new Map<string, number>();

          const dayNames = [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ];

          let totalEngagementRate = 0;
          let engagementVideoCount = 0;

          for (const video of selectedVideos) {
            const normalizedTitle = video.title
              .toLowerCase()
              .replace(/https?:\/\/\S+/g, " ")
              .replace(/[^a-z0-9#'\s]/g, " ");

            const words = normalizedTitle
              .split(/\s+/)
              .filter((word) => word.length >= 3)
              .filter((word) => ![
                "the", "and", "for", "you", "your",
                "with", "this", "that", "can", "are",
                "how", "what", "why", "only", "from",
                "shorts",
              ].includes(word));

            for (const word of new Set(words)) {
              titleWords.set(
                word,
                (titleWords.get(word) || 0) + 1,
              );
            }

            if (video.title.includes("?")) questionTitles++;
            if (video.title.includes("#")) hashtagTitles++;
            if (/\d/.test(video.title)) titlesWithNumbers++;

            const publishedDate = new Date(video.publishedAt);

            if (Number.isFinite(publishedDate.getTime())) {
              const hour = publishedDate.getUTCHours();
              const day = dayNames[publishedDate.getUTCDay()];

              publishingHours.set(
                hour,
                (publishingHours.get(hour) || 0) + 1,
              );

              publishingDays.set(
                day,
                (publishingDays.get(day) || 0) + 1,
              );
            }

            if (
              video.likes !== null &&
              video.views > 0
            ) {
              const engagement =
                ((video.likes + (video.comments || 0)) /
                  video.views) * 100;

              totalEngagementRate += engagement;
              engagementVideoCount++;
            }
          }

          const count = selectedVideos.length;

          const percentage = (value: number) =>
            count > 0
              ? Number(((value / count) * 100).toFixed(1))
              : null;

          const topEntries = (
            map: Map<string | number, number>,
            limit: number,
          ) =>
            [...map.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, limit)
              .map(([value, occurrences]) => ({
                value,
                occurrences,
              }));

          const durationBuckets = format === "shorts"
            ? [
                { label: "0–15 seconds", min: 0, max: 15 },
                { label: "16–30 seconds", min: 16, max: 30 },
                { label: "31–60 seconds", min: 31, max: 60 },
                { label: "61–180 seconds", min: 61, max: 180 },
              ]
            : [
                { label: "3–5 minutes", min: 181, max: 300 },
                { label: "5–10 minutes", min: 301, max: 600 },
                { label: "10–20 minutes", min: 601, max: 1200 },
                { label: "20–40 minutes", min: 1201, max: 2400 },
                { label: "Over 40 minutes", min: 2401, max: Infinity },
              ];

          const durationDistribution = durationBuckets.map(
            (bucket) => {
              const matching = selectedVideos.filter(
                (video) =>
                  video.durationSeconds >= bucket.min &&
                  video.durationSeconds <= bucket.max,
              );

              return {
                durationRange: bucket.label,
                videoCount: matching.length,
                percentage: percentage(matching.length),
                medianViews: median(
                  matching.map((video) => video.views),
                ),
              };
            },
          );

          const topVideos = [...selectedVideos]
            .sort((a, b) => b.views - a.views)
            .slice(0, 10);

          return {
            format,
            classification:
              format === "shorts"
                ? "Potential Shorts: duration at or below 180 seconds. Aspect ratio is not verified."
                : "Long-form candidates: duration above 180 seconds.",
            videosAnalyzed: count,
            channelCount: new Set(
              selectedVideos.map((video) => video.channelId),
            ).size,
            performance: {
              medianViews,
              averageViews,
              totalViews: selectedVideos.reduce(
                (sum, video) => sum + video.views,
                0,
              ),
              averageEngagementRatePercent:
                engagementVideoCount > 0
                  ? Number(
                      (
                        totalEngagementRate /
                        engagementVideoCount
                      ).toFixed(2),
                    )
                  : null,
              engagementNote:
                "Engagement rate is calculated as (likes + comments) / views. It is not a measure of watch retention.",
            },
            titlePatterns: {
              questionTitles: {
                count: questionTitles,
                percentage: percentage(questionTitles),
              },
              hashtagTitles: {
                count: hashtagTitles,
                percentage: percentage(hashtagTitles),
              },
              titlesWithNumbers: {
                count: titlesWithNumbers,
                percentage: percentage(titlesWithNumbers),
              },
              recurringWords: topEntries(titleWords, 15),
            },
            durationPatterns: {
              medianDurationSeconds: durationMedian,
              distribution: durationDistribution,
            },
            publishingPatterns: {
              busiestUtcHours: topEntries(
                publishingHours,
                5,
              ),
              busiestUtcDays: topEntries(
                publishingDays,
                7,
              ),
              timezone: "UTC",
            },
            topVideos: topVideos.map((video) => ({
              videoId: video.videoId,
              title: video.title,
              channelTitle: video.channelTitle,
              publishedAt: video.publishedAt,
              ageDays: video.ageDays,
              durationSeconds: video.durationSeconds,
              views: video.views,
              likes: video.likes,
              comments: video.comments,
              videoUrl: video.videoUrl,
              thumbnail: video.thumbnail,
            })),
            evidenceLimitations: [
              "Patterns are descriptive observations, not proof that a title or publishing time caused higher views.",
              "Views are lifetime public view counts, not views measured at a fixed age.",
              "The API does not provide reliable thumbnail image analysis or verified aspect ratio in this tool.",
              "A duration of 180 seconds or less is a potential Short classification only.",
              "Publishing times are reported in UTC.",
            ],
          };
        }

        const reports: Record<string, unknown> = {};

        if (contentType === "shorts" || contentType === "both") {
          reports.shorts = analyzeFormat("shorts");
        }

        if (
          contentType === "long_form" ||
          contentType === "both"
        ) {
          reports.longForm = analyzeFormat("long_form");
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  source: "YouTube Data API v3",
                  tool: "TubePilot Universal Content Pattern Detector",
                  version: "0.8.0",
                  contentType,
                  niche: niche || null,
                  requestedChannels: uniqueChannelIds.length,
                  channelsFound: channelUploads.filter(
                    (channel) => !channel.error,
                  ).length,
                  missingChannelIds,
                  maxVideosPerChannel,
                  minimumAgeDays,
                  channelSummary: videosByChannel.map((channel) => ({
                    channelId: channel.channelId,
                    channelTitle: channel.channelTitle,
                    subscriberCount: channel.subscriberCount,
                    videosAnalyzed: channel.videos.length,
                    error: channel.error,
                  })),
                  reports,
                  notes: [
                    "Shorts and long-form are analyzed independently and are never mixed in the same performance baseline.",
                    "The shorts classification is based on duration only and does not verify aspect ratio.",
                    "The tool analyzes recent public uploads, not private analytics.",
                    "The niche field provides research context; it does not filter videos automatically.",
                    "A minimum age of zero includes newly published uploads.",
                    "Small sample sizes can produce unstable patterns. Interpret findings using the number of videos analyzed.",
                  ],
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        console.error("Content pattern detector error:", error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error
                ? error.message
                : "Unable to analyze YouTube content patterns.",
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
