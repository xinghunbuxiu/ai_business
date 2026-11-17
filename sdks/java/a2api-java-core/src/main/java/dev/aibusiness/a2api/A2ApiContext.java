package dev.aibusiness.a2api;

public record A2ApiContext(
    A2ApiIdentity identity,
    String appId,
    String requestId,
    String traceId,
    String idempotencyKey
) {}
