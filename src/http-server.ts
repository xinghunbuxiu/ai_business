import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { A2API_PROTOCOL_VERSION, type A2APIInvocation, type Identity } from "./types.js";
import { ExecutionRuntime } from "./runtime.js";

export type A2ApiHttpIdentityResolver = (request: IncomingMessage) => Promise<Identity | undefined> | Identity | undefined;

export type A2ApiHttpServerOptions = {
  path?: string;
  maxRequestBytes?: number;
  /** Explicitly enable only when TLS is terminated by a trusted reverse proxy. */
  trustProxyTlsTermination?: boolean;
};

const InvocationSchema = {
  safeParse(value: unknown): { success: true; data: A2APIInvocation } | { success: false } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { success: false };
    const v = value as Record<string, unknown>;
    const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= 256;
    if (v.protocolVersion !== A2API_PROTOCOL_VERSION || !nonEmpty(v.capabilityId) || !nonEmpty(v.capabilityVersion) ||
      !nonEmpty(v.requestId) || !nonEmpty(v.traceId) || !nonEmpty(v.appId) || !nonEmpty(v.idempotencyKey) ||
      !Object.prototype.hasOwnProperty.call(v, "input")) return { success: false };
    return { success: true, data: v as unknown as A2APIInvocation };
  }
};

function send(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(serialized);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { statusCode: 413 });
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("INVALID_JSON"), { statusCode: 400 });
  }
}

/**
 * Minimal Node HTTP host for the A2API Runtime.
 * Authentication is delegated to the host application; the request body is never
 * treated as an identity source. Put this server behind TLS and a real auth layer.
 */
export function createA2ApiHttpServer(
  runtime: ExecutionRuntime,
  resolveIdentity: A2ApiHttpIdentityResolver,
  options: A2ApiHttpServerOptions = {}
): Server {
  const route = options.path ?? "/a2api/invoke";
  const maxBytes = options.maxRequestBytes ?? 1_048_576;

  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url?.split("?")[0] !== route) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
      return;
    }
    if (!request.headers["content-type"]?.toLowerCase().includes("application/json")) {
      send(response, 415, { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type must be application/json" } });
      return;
    }
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (declaredLength > maxBytes) {
      send(response, 413, { error: { code: "REQUEST_TOO_LARGE", message: "Request body exceeds the configured size limit" } });
      request.resume();
      return;
    }

    let identity: Identity | undefined;
    try {
      identity = await resolveIdentity(request);
    } catch {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Authentication could not be established" } });
      return;
    }
    if (!identity || !identity.userId || !Array.isArray(identity.roles)) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "A verified caller identity is required" } });
      return;
    }

    try {
      const body = await readJson(request, maxBytes);
      const parsed = InvocationSchema.safeParse(body);
      if (!parsed.success) {
        send(response, 400, { error: { code: "INVALID_INVOCATION", message: "Request does not match the A2API invocation envelope" } });
        return;
      }
      const result = await runtime.executeInvocation(parsed.data, identity);
      send(response, 200, result);
    } catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 400;
      const code = error instanceof Error ? error.message : "REQUEST_FAILED";
      send(response, status, { error: { code, message: status === 413 ? "Request body exceeds the configured size limit" : "Request could not be processed" } });
    }
  });
}
