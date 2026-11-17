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
            if (handler.capabilityId() == null || handler.capabilityVersion() == null || handler.inputType() == null) {
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
        A2ApiHandler<?, ?> handler = handlers.get(key(invocation.capabilityId(), invocation.capabilityVersion()));
        if (handler == null) {
            throw new A2ApiException("CAPABILITY_NOT_FOUND", "No Java handler is registered for this exact capability version", false);
        }
        return invokeTyped(handler, invocation.input(), context);
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

    private static String key(String id, String version) { return id + "@" + version; }
}
