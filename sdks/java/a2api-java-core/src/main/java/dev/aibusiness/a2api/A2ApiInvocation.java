package dev.aibusiness.a2api;

import com.fasterxml.jackson.databind.JsonNode;

public record A2ApiInvocation(
    String protocolVersion,
    String capabilityId,
    String capabilityVersion,
    String requestId,
    String traceId,
    String appId,
    String idempotencyKey,
    JsonNode input
) {}
