package dev.aibusiness.a2api;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.annotation.JsonInclude;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record A2ApiResult(
    String protocolVersion,
    String requestId,
    String traceId,
    boolean success,
    JsonNode data,
    A2ApiError error
) {
    public static A2ApiResult success(String requestId, String traceId, JsonNode data) {
        return new A2ApiResult(A2ApiProtocol.VERSION, requestId, traceId, true, data, null);
    }

    public static A2ApiResult failure(String requestId, String traceId, String code, String message, boolean retryable) {
        return new A2ApiResult(A2ApiProtocol.VERSION, requestId, traceId, false, null, new A2ApiError(code, message, retryable));
    }
}
