import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AuthenticatedProviderProject, ProviderControlPlane } from "./provider-control-plane.js";
import type { ProviderRecordKey } from "./provider-repository.js";

export type ProviderHttpIdentityResolver = (
  request: IncomingMessage
) => Promise<AuthenticatedProviderProject | undefined> | AuthenticatedProviderProject | undefined;

export type ProviderHttpServerOptions = {
  basePath?: string;
  maxRequestBytes?: number;
};

const environments = new Set(["dev", "test", "staging", "prod"]);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 256;

function send(response: ServerResponse, status: number, body: unknown): void {
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
    pragma: "no-cache",
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

function isActor(value: unknown): value is AuthenticatedProviderProject {
  if (!value || typeof value !== "object") return false;
  const actor = value as Record<string, unknown>;
  return nonEmpty(actor.projectId) && nonEmpty(actor.serviceId) &&
    nonEmpty(actor.providerId) && nonEmpty(actor.subject) &&
    Array.isArray(actor.permissions) && actor.permissions.every(nonEmpty);
}

function keyFrom(actor: AuthenticatedProviderProject, value: unknown): ProviderRecordKey | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  if (typeof body.environment !== "string" || !environments.has(body.environment) || !nonEmpty(body.instanceId)) return undefined;
  return {
    projectId: actor.projectId,
    serviceId: actor.serviceId,
    providerId: actor.providerId,
    environment: body.environment as ProviderRecordKey["environment"],
    instanceId: body.instanceId
  };
}

function errorResponse(error: unknown): { status: number; body: unknown } {
  const explicitStatus = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : undefined;
  const message = error instanceof Error ? error.message : "REQUEST_FAILED";
  const code = message.split(":", 1)[0] || "REQUEST_FAILED";
  const status = explicitStatus ?? (
    code.includes("UNAUTHENTICATED") ? 401 :
    code.includes("FORBIDDEN") ? 403 :
    code.includes("NOT_FOUND") ? 404 :
    code.includes("ALREADY_REGISTERED") ? 409 :
    code.includes("INVALID") || code.includes("MISMATCH") || code.includes("NOT_PUBLISHED") ? 400 :
    code.includes("NOT_ACTIVE") || code.includes("RENEWAL_REJECTED") ? 409 : 500);
  const safeMessage = status === 500 ? "Provider control-plane request failed" : message.slice(0, 512);
  return { status, body: { error: { code, message: safeMessage } } };
}

/**
 * Minimal Node HTTP adapter for ProviderControlPlane.
 * The host must terminate TLS and resolve identity from verified credentials.
 * Provider ownership fields are always taken from that resolved identity.
 */
export function createProviderHttpServer(
  controlPlane: ProviderControlPlane,
  resolveIdentity: ProviderHttpIdentityResolver,
  options: ProviderHttpServerOptions = {}
): Server {
  const basePath = (options.basePath ?? "/providers").replace(/\/$/, "");
  const maxBytes = options.maxRequestBytes ?? 256 * 1024;

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://provider-control.local");
    const path = url.pathname;
    if (!path.startsWith(basePath + "/")) {
      send(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
      return;
    }

    let actor: AuthenticatedProviderProject | undefined;
    try {
      actor = await resolveIdentity(request);
    } catch {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "Authentication could not be established" } });
      return;
    }
    if (!isActor(actor)) {
      send(response, 401, { error: { code: "UNAUTHENTICATED", message: "A verified provider identity is required" } });
      return;
    }

    try {
      if (request.method === "GET" && path === basePath + "/discover") {
        const capabilityId = url.searchParams.get("capabilityId");
        const capabilityVersion = url.searchParams.get("capabilityVersion");
        const environment = url.searchParams.get("environment");
        if (!nonEmpty(capabilityId) || !nonEmpty(capabilityVersion) ||
            !environment || !environments.has(environment)) {
          send(response, 400, { error: { code: "PROVIDER_DISCOVERY_INVALID", message: "capabilityId, capabilityVersion and environment are required" } });
          return;
        }
        send(response, 200, { providers: await controlPlane.discover({
          capabilityId, capabilityVersion,
          environment: environment as ProviderRecordKey["environment"]
        }, actor) });
        return;
      }

      const statusParts = path.slice(basePath.length + 1).split("/");
      if (request.method === "GET" && statusParts.length === 3 &&
          environments.has(statusParts[0]) && statusParts[2] === "status") {
        let instanceId: string;
        try { instanceId = decodeURIComponent(statusParts[1]); }
        catch { send(response, 400, { error: { code: "PROVIDER_INSTANCE_KEY_INVALID", message: "Invalid instanceId encoding" } }); return; }
        if (!nonEmpty(instanceId)) {
          send(response, 400, { error: { code: "PROVIDER_INSTANCE_KEY_INVALID", message: "instanceId is required" } });
          return;
        }
        const key: ProviderRecordKey = {
          projectId: actor.projectId, serviceId: actor.serviceId, providerId: actor.providerId,
          environment: statusParts[0] as ProviderRecordKey["environment"],
          instanceId
        };
        send(response, 200, { provider: await controlPlane.status(key, actor) });
        return;
      }

      const action = path.slice(basePath.length + 1);
      if (request.method !== "POST" || !["register", "heartbeat", "drain", "revoke"].includes(action)) {
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
      const body = await readJson(request, maxBytes);
      if (action === "register") {
        send(response, 201, await controlPlane.register(body, actor));
        return;
      }
      const key = keyFrom(actor, body);
      if (!key) {
        send(response, 400, { error: { code: "PROVIDER_INSTANCE_KEY_INVALID", message: "environment and instanceId are required" } });
        return;
      }
      const result = action === "heartbeat" ? await controlPlane.heartbeat(key, actor) :
        action === "drain" ? await controlPlane.drain(key, actor) :
        await controlPlane.revoke(key, actor);
      send(response, 200, result);
    } catch (error) {
      const mapped = errorResponse(error);
      send(response, mapped.status, mapped.body);
    }
  });
}
