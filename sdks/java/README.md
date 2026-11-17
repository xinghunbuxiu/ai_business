# A2API Java SDK (initial provider slice)

This Maven reactor contains:

- `a2api-java-core`: protocol envelopes, identity/context types, typed handler contract and exact-version handler registry.
- `a2api-java-spring-boot-starter`: Spring MVC provider endpoint at `POST /internal/a2api/invoke`.

## Expose an existing Java service

Implement one explicit handler per published capability pin. Keep the domain service and its transaction boundaries unchanged.

```java
@Component
public final class CreateOrderHandler implements A2ApiHandler<CreateOrderInput, CreateOrderOutput> {
    private final OrderService orders;

    public CreateOrderHandler(OrderService orders) { this.orders = orders; }

    public String capabilityId() { return "commerce.orders.create"; }
    public String capabilityVersion() { return "1.0.0"; }
    public Class<CreateOrderInput> inputType() { return CreateOrderInput.class; }

    public CreateOrderOutput handle(CreateOrderInput input, A2ApiContext context) {
        return orders.create(input, context.identity().tenantId(), context.identity().userId());
    }
}
```

Provide an `A2ApiIdentityResolver` bean. It must map an authenticated Spring Security principal to verified user, tenant, role and permission claims. The controller is not registered unless this bean exists. Configure Spring Security in the host application to protect `/internal/a2api/**` with OAuth2 resource server, mTLS gateway authentication or another approved service identity mechanism.

The request body is not an identity source. Never add tenant/roles/permissions fields to `A2ApiInvocation` and trust them.

## Contract and operational boundaries

The TypeScript Runtime validates the input against the published JSON Schema before dispatch and validates the provider output after response. The Java starter additionally performs exact capability ID/version dispatch and DTO binding. Production rollout should add local JSON Schema validation, durable idempotency at the domain boundary, request size limits, rate limiting and trace instrumentation. Do not expose the endpoint publicly without host-application authentication and authorization.

Build with Java 17+ and Maven:

```bash
cd sdks/java
mvn test
```

This is the initial provider endpoint slice, not a complete production Java SDK: the typed Java consumer client, registration/heartbeat client, JSON Schema validator and contract conformance suite are pending.
