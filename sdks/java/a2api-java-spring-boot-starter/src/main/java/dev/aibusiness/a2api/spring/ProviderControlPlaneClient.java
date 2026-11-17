package dev.aibusiness.a2api.spring;

import com.fasterxml.jackson.databind.JsonNode;
import dev.aibusiness.a2api.A2ApiException;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

/**
 * Client for the A2API Provider Registration 1.0.0 control-plane endpoints.
 *
 * Authentication must be configured on the supplied RestClient by the host
 * (for example OAuth2 client credentials or mTLS at a trusted gateway).
 * Provider ownership is bound to that authenticated credential by the server;
 * these methods never send an actor, project principal or permission claim.
 */
public final class ProviderControlPlaneClient {
    public static final String REGISTRATION_PROTOCOL_VERSION = "1.0.0";

    private final RestClient restClient;

    public ProviderControlPlaneClient(RestClient restClient) {
        this.restClient = Objects.requireNonNull(restClient, "restClient");
    }

    public RegistrationResult register(Registration registration) {
        Objects.requireNonNull(registration, "registration");
        JsonNode response = post("/providers/register", registration);
        String state = requiredText(response, "state");
        if (!"active".equals(state)) {
            throw new A2ApiException("PROVIDER_REGISTRATION_RESPONSE_INVALID",
                "Control plane did not activate the registered provider", false);
        }
        return new RegistrationResult(
            requiredText(response, "provider"),
            requiredText(response, "instance"),
            state,
            Instant.parse(requiredText(response, "leaseExpiresAt"))
        );
    }

    public LeaseResult heartbeat(String environment, String instanceId) {
        JsonNode response = post("/providers/heartbeat", new InstanceRequest(environment, instanceId));
        String state = requiredText(response, "state");
        if (!"active".equals(state)) {
            throw new A2ApiException("PROVIDER_HEARTBEAT_RESPONSE_INVALID",
                "Control plane returned a non-active provider state", false);
        }
        return new LeaseResult(state, Instant.parse(requiredText(response, "leaseExpiresAt")));
    }

    public void drain(String environment, String instanceId) {
        requireState(post("/providers/drain", new InstanceRequest(environment, instanceId)), "draining");
    }

    public void revoke(String environment, String instanceId) {
        requireState(post("/providers/revoke", new InstanceRequest(environment, instanceId)), "revoked");
    }

    private JsonNode post(String path, Object body) {
        try {
            JsonNode response = restClient.post()
                .uri(path)
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve()
                .body(JsonNode.class);
            if (response == null || !response.isObject()) {
                throw new A2ApiException("PROVIDER_CONTROL_PLANE_EMPTY_RESPONSE",
                    "Provider control plane returned an empty or invalid response", true);
            }
            if (response.has("error")) {
                JsonNode error = response.path("error");
                throw new A2ApiException(
                    textOr(error, "code", "PROVIDER_CONTROL_PLANE_ERROR"),
                    textOr(error, "message", "Provider control-plane request failed"),
                    false
                );
            }
            return response;
        } catch (RestClientResponseException exception) {
            String code = "PROVIDER_CONTROL_PLANE_HTTP_" + exception.getStatusCode().value();
            String message = "Provider control-plane request failed with HTTP " + exception.getStatusCode().value();
            try {
                JsonNode error = restClientMessage(exception);
                if (error != null) {
                    code = textOr(error, "code", code);
                    message = textOr(error, "message", message);
                }
            } catch (RuntimeException ignored) {
                // Keep the safe HTTP-level error if the server body is not JSON.
            }
            throw new A2ApiException(code, message, exception.getStatusCode().is5xxServerError());
        }
    }

    private JsonNode restClientMessage(RestClientResponseException exception) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(exception.getResponseBodyAsByteArray()).path("error");
        } catch (java.io.IOException exceptionParsingBody) {
            return null;
        }
    }

    private static void requireState(JsonNode response, String expected) {
        if (!expected.equals(requiredText(response, "state"))) {
            throw new A2ApiException("PROVIDER_CONTROL_PLANE_RESPONSE_INVALID",
                "Control plane did not confirm provider state " + expected, false);
        }
    }

    private static String requiredText(JsonNode node, String field) {
        String value = textOr(node, field, null);
        if (value == null || value.isBlank()) {
            throw new A2ApiException("PROVIDER_CONTROL_PLANE_RESPONSE_INVALID",
                "Provider control-plane response is missing " + field, false);
        }
        return value;
    }

    private static String textOr(JsonNode node, String field, String fallback) {
        JsonNode value = node == null ? null : node.get(field);
        return value != null && value.isTextual() ? value.asText() : fallback;
    }

    public record CapabilityPin(String capabilityId, String capabilityVersion, String contractHash) {}
    public record Transport(String type, String bindingRef) {}
    public record Lease(Instant issuedAt, Instant expiresAt) {}
    public record Registration(
        String registrationProtocolVersion,
        String projectId,
        String serviceId,
        String providerId,
        String environment,
        String instanceId,
        List<CapabilityPin> capabilities,
        Transport transport,
        Lease lease
    ) {
        public Registration {
            if (!REGISTRATION_PROTOCOL_VERSION.equals(registrationProtocolVersion)) {
                throw new IllegalArgumentException("registrationProtocolVersion must be " + REGISTRATION_PROTOCOL_VERSION);
            }
            capabilities = List.copyOf(Objects.requireNonNull(capabilities, "capabilities"));
            Objects.requireNonNull(transport, "transport");
            Objects.requireNonNull(lease, "lease");
            Objects.requireNonNull(lease.issuedAt(), "lease.issuedAt");
            Objects.requireNonNull(lease.expiresAt(), "lease.expiresAt");
            if (!lease.expiresAt().isAfter(lease.issuedAt())) {
                throw new IllegalArgumentException("lease.expiresAt must be after lease.issuedAt");
            }
        }
    }
    public record InstanceRequest(String environment, String instanceId) {
        public InstanceRequest {
            Objects.requireNonNull(environment, "environment");
            Objects.requireNonNull(instanceId, "instanceId");
            if (!List.of("dev", "test", "staging", "prod").contains(environment)) {
                throw new IllegalArgumentException("Unsupported provider environment");
            }
            if (instanceId.isBlank() || instanceId.length() > 128) {
                throw new IllegalArgumentException("instanceId must contain 1 to 128 characters");
            }
        }
    }
    public record RegistrationResult(String provider, String instance, String state, Instant leaseExpiresAt) {}
    public record LeaseResult(String state, Instant leaseExpiresAt) {}
}
