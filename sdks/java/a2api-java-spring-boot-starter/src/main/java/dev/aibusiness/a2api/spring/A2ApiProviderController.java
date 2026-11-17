package dev.aibusiness.a2api.spring;

import dev.aibusiness.a2api.*;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping(path = "/internal/a2api", produces = MediaType.APPLICATION_JSON_VALUE)
public final class A2ApiProviderController {
    private final A2ApiHandlerRegistry handlers;
    private final A2ApiIdentityResolver identityResolver;

    public A2ApiProviderController(A2ApiHandlerRegistry handlers, A2ApiIdentityResolver identityResolver) {
        this.handlers = handlers;
        this.identityResolver = identityResolver;
    }

    @PostMapping(path = "/invoke", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<A2ApiResult> invoke(@RequestBody A2ApiInvocation invocation, Authentication authentication) {
        String requestId = safe(invocation.requestId());
        String traceId = safe(invocation.traceId());
        try {
            if (authentication == null || !authentication.isAuthenticated()) {
                return ResponseEntity.status(401).body(A2ApiResult.failure(requestId, traceId, "UNAUTHENTICATED", "Authentication is required", false));
            }
            A2ApiIdentity identity = identityResolver.resolve(authentication);
            if (identity == null || identity.userId() == null || identity.userId().isBlank()) {
                return ResponseEntity.status(403).body(A2ApiResult.failure(requestId, traceId, "IDENTITY_UNAVAILABLE", "Trusted caller identity is unavailable", false));
            }
            A2ApiContext context = new A2ApiContext(identity, invocation.appId(), requestId, traceId, invocation.idempotencyKey());
            var data = handlers.invoke(invocation, context);
            return ResponseEntity.ok(A2ApiResult.success(requestId, traceId, data));
        } catch (A2ApiException exception) {
            return ResponseEntity.ok(A2ApiResult.failure(requestId, traceId, exception.code(), exception.getMessage(), exception.retryable()));
        } catch (Exception exception) {
            return ResponseEntity.internalServerError().body(A2ApiResult.failure(requestId, traceId, "PROVIDER_INTERNAL_ERROR", "Provider request failed", false));
        }
    }

    private static String safe(String value) { return value == null || value.isBlank() ? "unknown" : value; }
}
