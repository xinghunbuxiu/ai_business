package dev.aibusiness.a2api.spring;

import com.fasterxml.jackson.databind.ObjectMapper;
import dev.aibusiness.a2api.A2ApiException;
import dev.aibusiness.a2api.A2ApiInvocation;
import dev.aibusiness.a2api.A2ApiResult;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;

/**
 * Typed consumer for a trusted, preconfigured Runtime RestClient.
 * Authentication headers must be configured by the host application (OAuth2,
 * mTLS gateway or equivalent); caller identity is never added to the body.
 */
public final class HttpA2ApiClient {
    private final RestClient restClient;
    private final ObjectMapper objectMapper;

    public HttpA2ApiClient(RestClient restClient, ObjectMapper objectMapper) {
        this.restClient = restClient;
        this.objectMapper = objectMapper;
    }

    public <T> T invoke(A2ApiInvocation invocation, Class<T> outputType) {
        A2ApiResult result = restClient.post()
            .uri("/a2api/invoke")
            .contentType(MediaType.APPLICATION_JSON)
            .accept(MediaType.APPLICATION_JSON)
            .body(invocation)
            .retrieve()
            .body(A2ApiResult.class);
        if (result == null) throw new A2ApiException("RUNTIME_EMPTY_RESPONSE", "A2API Runtime returned an empty response", true);
        if (!result.success()) {
            var error = result.error();
            throw new A2ApiException(
                error == null ? "RUNTIME_ERROR" : error.code(),
                error == null ? "A2API Runtime invocation failed" : error.message(),
                error != null && error.retryable()
            );
        }
        return objectMapper.convertValue(result.data(), outputType);
    }
}
