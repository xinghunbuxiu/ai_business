package dev.aibusiness.a2api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class A2ApiHandlerRegistry {
    private final Map<String, A2ApiHandler<?, ?>> handlers = new HashMap<>();
    private final ObjectMapper objectMapper;

    public A2ApiHandlerRegistry(List<A2ApiHandler<?, ?>> discoveredHandlers, ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
        for (A2ApiHandler<?, ?> handler : discoveredHandlers) {
            if (handler.capabilityId() == null || !handler.capabilityId().matches("^[a-z][a-z0-9_.-]+$")
                || handler.capabilityVersion() == null || !handler.capabilityVersion().matches("^\\d+\\.\\d+\\.\\d+(?:-[A-Za-z0-9.-]+)?$")
                || handler.inputType() == null || handler.requiredRoles() == null || handler.requiredRoles().isEmpty()
                || handler.requiredPermissions() == null) {
                throw new IllegalStateException("A2API_HANDLER_METADATA_INVALID");
            }
            String key = key(handler.capabilityId(), handler.capabilityVersion());
            if (handlers.putIfAbsent(key, handler) != null) {
                throw new IllegalStateException("A2API_HANDLER_DUPLICATE: " + key);
            }
        }
    }

    public JsonNode invoke(A2ApiInvocation invocation, A2ApiContext context) {
        if (!A2ApiProtocol.VERSION.equals(invocation.protocolVersion())) {
            throw new A2ApiException("UNSUPPORTED_PROTOCOL_VERSION", "Unsupported A2API protocol version", false);
        }
        if (invocation.capabilityId() == null || invocation.capabilityVersion() == null) {
            throw new A2ApiException("CAPABILITY_VERSION_REQUIRED", "An exact capability ID and version are required", false);
        }
        if (blank(invocation.requestId()) || blank(invocation.traceId()) || blank(invocation.appId())) {
            throw new A2ApiException("INVOCATION_METADATA_INVALID", "requestId, traceId and appId are required", false);
        }
        A2ApiHandler<?, ?> handler = handlers.get(key(invocation.capabilityId(), invocation.capabilityVersion()));
        if (handler == null) {
            throw new A2ApiException("CAPABILITY_NOT_FOUND", "No Java handler is registered for this exact capability version", false);
        }
        if (handler.idempotencyRequired() && blank(invocation.idempotencyKey())) {
            throw new A2ApiException("IDEMPOTENCY_KEY_REQUIRED", "This capability requires an idempotency key", false);
        }
        authorize(handler, context.identity());
        return invokeTyped(handler, invocation.input(), context);
    }

    private void authorize(A2ApiHandler<?, ?> handler, A2ApiIdentity identity) {
        if (identity == null) throw new A2ApiException("IDENTITY_UNAVAILABLE", "Trusted caller identity is unavailable", false);
        if (handler.tenantRequired() && (identity.tenantId() == null || identity.tenantId().isBlank())) {
            throw new A2ApiException("TENANT_REQUIRED", "A tenant identity is required", false);
        }
        if (handler.requiredRoles().stream().noneMatch(identity.roles()::contains)) {
            throw new A2ApiException("FORBIDDEN", "Caller does not have a permitted role", false);
        }
        if (!identity.permissions().containsAll(handler.requiredPermissions())) {
            throw new A2ApiException("FORBIDDEN", "Caller is missing one or more required permissions", false);
        }
    }

    private <I, O> JsonNode invokeTyped(A2ApiHandler<I, O> handler, JsonNode input, A2ApiContext context) {
        try {
            I value = objectMapper.treeToValue(input, handler.inputType());
            O output = handler.handle(value, context);
            return objectMapper.valueToTree(output);
        } catch (A2ApiException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new A2ApiException("PROVIDER_HANDLER_ERROR", "Provider handler failed", false);
        }
    }

    private static boolean blank(String value) { return value == null || value.isBlank(); }
    private static String key(String id, String version) { return id + "@" + version; }
}
