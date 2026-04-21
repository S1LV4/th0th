/**
 * SSE Events Route
 *
 * GET /api/v1/events — Server-Sent Events stream for real-time indexing progress.
 *
 * Optional query param: ?projectId=<id> to filter events for a specific project.
 * Keep-alive heartbeat every 15s.
 * Connection auto-closes after 10 minutes (client should reconnect).
 */

import { Elysia } from "elysia";
import { eventBus } from "@th0th-ai/core";

const HEARTBEAT_MS = 15_000;
const MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes

export const eventsRoutes = new Elysia({ prefix: "/api/v1" }).get(
  "/events",
  async ({ query, set }) => {
    const projectIdFilter = query.projectId as string | undefined;

    // Configure SSE headers
    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";
    set.headers["X-Accel-Buffering"] = "no"; // Disable nginx buffering

    const encoder = new TextEncoder();
    let closed = false;

    const stream = new ReadableStream({
      start(controller) {
        const enqueue = (data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };

        // Subscribe to all indexing + workspace events
        const events = [
          "indexing:started",
          "indexing:progress",
          "indexing:file",
          "indexing:completed",
          "indexing:failed",
          "workspace:updated",
        ] as const;

        const unsubscribers = events.map((event) =>
          eventBus.subscribe(event, (payload: Record<string, unknown>) => {
            // Filter by projectId if specified
            if (projectIdFilter && payload.projectId !== projectIdFilter) return;
            enqueue({ event, payload, timestamp: new Date().toISOString() });
          }),
        );

        // Heartbeat to keep connection alive
        const heartbeatTimer = setInterval(() => {
          if (closed) {
            clearInterval(heartbeatTimer);
            return;
          }
          try {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          } catch {
            closed = true;
            clearInterval(heartbeatTimer);
          }
        }, HEARTBEAT_MS);

        // Auto-close after MAX_DURATION_MS
        const closeTimer = setTimeout(() => {
          closed = true;
          unsubscribers.forEach((u) => u());
          clearInterval(heartbeatTimer);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }, MAX_DURATION_MS);

        // Send initial connected event
        enqueue({ event: "connected", payload: { projectIdFilter: projectIdFilter ?? null }, timestamp: new Date().toISOString() });

        // Cleanup on stream cancel (client disconnected)
        return () => {
          closed = true;
          unsubscribers.forEach((u) => u());
          clearInterval(heartbeatTimer);
          clearTimeout(closeTimer);
        };
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  },
  {
    detail: {
      tags: ["events"],
      summary: "Real-time indexing progress via SSE",
      description:
        "Subscribe to Server-Sent Events for indexing progress and workspace status updates. Optional ?projectId= to filter to a specific project. Connection auto-closes after 10 minutes.",
    },
  },
);
