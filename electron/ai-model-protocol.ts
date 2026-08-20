import { protocol } from "electron";

import { isAiModelId } from "../lib/ai/types";
import type { AiModelService } from "./ai-model-service";

const SCHEME = "darkroom-model";
const RESPONSE_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

export function registerAiModelScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      ...RESPONSE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export function registerAiModelProtocol(service: AiModelService): void {
  protocol.handle(SCHEME, async (request) => {
    if (request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: {
          ...RESPONSE_HEADERS,
          Allow: "GET",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return errorResponse(400, "Bad request");
    }
    const pathParts = url.pathname.split("/");
    const modelId = pathParts.length === 2 ? pathParts[1] : undefined;
    if (
      url.protocol !== `${SCHEME}:` ||
      url.hostname !== "model" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !isAiModelId(modelId)
    ) {
      return errorResponse(404, "Not found");
    }

    try {
      const verified = await service.openVerifiedModel(modelId);
      let position = 0;
      let closed = false;
      const close = async () => {
        if (closed) {
          return;
        }
        closed = true;
        await verified.handle.close().catch(() => undefined);
      };
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = Buffer.allocUnsafe(
              Math.min(1024 * 1024, verified.bytes - position),
            );
            const result = await verified.handle.read(
              chunk,
              0,
              chunk.byteLength,
              position,
            );
            if (result.bytesRead === 0) {
              await close();
              if (position !== verified.bytes) {
                controller.error(new Error("Cached model changed while streaming."));
              } else {
                controller.close();
              }
              return;
            }
            position += result.bytesRead;
            controller.enqueue(chunk.subarray(0, result.bytesRead));
            if (position === verified.bytes) {
              await close();
              controller.close();
            }
          } catch (error) {
            await close();
            controller.error(error);
          }
        },
        async cancel() {
          await close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: {
          ...RESPONSE_HEADERS,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(verified.bytes),
        },
      });
    } catch {
      return errorResponse(404, "Model unavailable");
    }
  });
}
