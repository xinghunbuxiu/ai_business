# A2API Java SDK (initial provider slice)

This Maven reactor contains:

- `a2api-java-core`: protocol envelopes, identity/context types, typed handler contract and exact-version handler registry.
- `a2api-java-spring-boot-starter`: Spring MVC provider endpoint at `POST /internal/a2api/invoke`.

## Expose an existing Java service

Implement one explicit handler per published capability pin. Declare its required roles, permissions and tenant requirement in the handler. Keep the domain service and its transaction boundaries unchanged.

```java
import java.util.Set;

@Component
public final class CreateOrderHandler implements A2ApiHandler<CreateOrderInput, CreateOrderOutput> {
    private final OrderService orders;

    public CreateOrderHandler(OrderService orders) { this.orders = orders; }

    public String capabilityId() { return "commerce.orders.create"; }
    public String capabilityVersion() { return "1.0.0"; }
    public Class<CreateOrderInput> inputType() { return CreateOrderInput.class; }
    public Set<String> requiredRoles() { return Set.of("merchant_owner"); }
    public Set<String> requiredPermissions() { return Set.of("order:create"); }
    public boolean tenantRequired() { return true; }
    public boolean idempotencyRequired() { return true; }

    public CreateOrderOutput handle(CreateOrderInput input, A2ApiContext context) {
        return orders.create(input, context.identity().tenantId(), context.identity().userId());
    }
}
```

Provide an `A2ApiIdentityResolver` bean. It must map an authenticated Spring Security principal to verified user, tenant, role and permission claims. The controller is not registered unless this bean exists. Configure Spring Security in the host application to protect `/internal/a2api/**` with OAuth2 resource server, mTLS gateway authentication or another approved service identity mechanism.

For Java-to-Runtime calls, use `HttpA2ApiClient` with a preconfigured Spring `RestClient`; configure service authentication on that client. It sends the same pinned A2API invocation envelope and maps declared Runtime errors to `A2ApiException`.

The request body is not an identity source. Never add tenant/roles/permissions fields to `A2ApiInvocation` and trust them.

## Contract and operational boundaries

The TypeScript Runtime validates the input against the published JSON Schema before dispatch and validates the provider output after response. The Java starter additionally performs exact capability ID/version dispatch and DTO binding. Production rollout should add local JSON Schema validation, durable idempotency at the domain boundary, request size limits, rate limiting and trace instrumentation. Do not expose the endpoint publicly without host-application authentication and authorization.

Build with Java 17+ and Maven:

```bash
cd sdks/java
mvn test
```

## Register a Java provider instance

The starter also includes `ProviderControlPlaneClient` for the shared Provider Registration 1.0.0 API. Supply a RestClient whose base URL and service authentication are configured by the host application. The control plane derives project/service/provider ownership and permissions from that verified credential; do not add identity claims to registration payloads.

```java
@Bean
ProviderControlPlaneClient providerControlPlaneClient(RestClient.Builder builder) {
    RestClient client = builder
        .baseUrl("https://control.example.internal")
        // Configure OAuth2 client credentials or your approved mTLS gateway here.
        .build();
    return new ProviderControlPlaneClient(client);
}
```

Build a registration from published exact pins and a provisioned transport binding:

```java
var registration = new ProviderControlPlaneClient.Registration(
    ProviderControlPlaneClient.REGISTRATION_PROTOCOL_VERSION,
    "commerce", "orders", "orders-provider", "prod", instanceId,
    List.of(new ProviderControlPlaneClient.CapabilityPin(
        "commerce.orders.create", "1.0.0", publishedContractSha256)),
    new ProviderControlPlaneClient.Transport("https-json", "binding://commerce/orders"),
    new ProviderControlPlaneClient.Lease(
        Instant.now(), Instant.now().plusSeconds(300))
);
providerControlPlaneClient.register(registration);
providerControlPlaneClient.heartbeat("prod", instanceId);
```

The host should schedule heartbeats well before the configured lease expires and stop advertising an instance when renewal fails. The client also exposes explicit `drain` and `revoke` operations. It does not retry registration or business invocations automatically: retries around writes must be governed by the control-plane operation semantics and the provider's own idempotency contract.

This is still an initial Java SDK slice, not a complete production SDK. Local JSON Schema validation, full protocol conformance tests, automated lease scheduling, provider lifecycle audit events and durable end-to-end PostgreSQL integration tests remain pending.
