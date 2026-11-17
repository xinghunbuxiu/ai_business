# A2API Java Adapter Specification 1.0.0

**Status:** implementation design; not yet a shipped Java SDK.  
**Protocol:** A2API 1.0.0.  
**Purpose:** define the Java/Spring integration boundary without coupling business services to the TypeScript Runtime.

## 1. Two integration directions

A2API has two distinct Java integration modes. They MUST NOT be confused:

1. **Java provider:** a Java/Spring service exposes its existing business methods as A2API capabilities. The A2API Gateway/Runtime invokes the provider over a trusted transport.
2. **Java consumer adapter:** the Java application invokes a published A2API capability hosted by the Runtime.

A Java service may implement both roles. The protocol envelope and authorization rules remain the same.

## 2. Recommended module layout

The future Maven multi-module SDK should be split by responsibility:

- `a2api-java-core`: protocol DTOs, SemVer, validation interfaces, error types.
- `a2api-java-spring-boot-starter`: Spring bean discovery, endpoint wiring, health/readiness.
- `a2api-java-provider`: explicit capability registry and method bindings.
- `a2api-java-client`: typed HTTP client for Runtime invocation.
- `a2api-java-testkit`: contract tests, schema fixtures and fake identity context.

Do not make the core depend on Spring. Spring integration is an optional adapter.

## 3. Java provider mapping

Use explicit annotations and registered handlers. Do not expose every public method by reflection.

Example business service:

```java
@Service
public class EmployeeService {
  public Employee create(CreateEmployeeCommand command, BusinessActor actor) {
    // Existing domain validation and transaction boundary stay here.
    return employeeRepository.save(Employee.create(command, actor.tenantId()));
  }
}
```

A provider binding explicitly maps the stable capability ID and asset version to a handler:

```java
@Component
public class EmployeeCreateCapability implements A2ApiHandler<CreateEmployeeInput, EmployeeOutput> {
  private final EmployeeService employees;

  public EmployeeCreateCapability(EmployeeService employees) {
    this.employees = employees;
  }

  @Override public String capabilityId() { return "employee.create"; }
  @Override public String capabilityVersion() { return "1.0.0"; }

  @Override
  public EmployeeOutput handle(CreateEmployeeInput input, A2ApiContext context) {
    var actor = new BusinessActor(context.identity().userId(),
                                 context.identity().tenantId());
    var employee = employees.create(input.toCommand(), actor);
    return EmployeeOutput.from(employee);
  }
}
```

The registry accepts only explicitly registered handlers. At startup it MUST fail on duplicate `capabilityId@version`, missing metadata, unsupported protocol versions, or a handler whose declared input/output contract does not match its published A2API asset.

## 4. Annotation option

An annotation can reduce boilerplate, but it is metadata only; it must not create an unsafe reflection endpoint.

```java
@A2ApiCapability(
  id = "employee.create",
  version = "1.0.0",
  protocolVersion = "1.0.0"
)
public EmployeeOutput create(CreateEmployeeInput input, A2ApiContext context) {
  // ...
}
```

The starter may scan annotated Spring beans at startup, validate the method signature, and build a fixed invocation table. Invocation must use the validated table; never accept a class name, method name, SpEL expression, script, or arbitrary bean name from a client request.

## 5. Wire contract

Provider transport should initially use authenticated HTTPS/JSON. The request follows the A2API 1.0.0 invocation envelope:

```json
{
  "protocolVersion": "1.0.0",
  "capabilityId": "employee.create",
  "capabilityVersion": "1.0.0",
  "requestId": "req-uuid",
  "traceId": "trace-uuid",
  "appId": "merchant-console",
  "idempotencyKey": "tenant-42:employee-create:req-99",
  "input": { "name": "Alex", "role": "cashier" }
}
```

The authenticated identity MUST come from a verified service token/session or trusted gateway context. A body field claiming `tenantId`, `roles`, or `permissions` MUST never override that identity. The provider maps the verified principal into `A2ApiContext`.

The response uses the standard A2API result envelope. Provider exceptions are mapped to stable declared error codes; stack traces, SQL, secrets and internal class names are not returned.

## 6. Contract mapping rules

| A2API asset field | Java mapping |
|---|---|
| `capabilityId` + `capabilityVersion` | Stable registry key; exact match only |
| `inputSchema` | JSON Schema validation before handler invocation; DTO binding after validation |
| `outputSchema` | Validate serialized handler result before returning |
| `auth.roles` / `permissions` | Enforce against verified identity before business method |
| `auth.tenantRequired` | Require trusted tenant context |
| `preconditions` | Named server-side precondition beans; no client-selected implementation |
| `mapping.adapter` / `operation` | Server-side binding configuration, never executable asset content |
| `mapping.timeoutMs` | Transport/handler deadline; propagate cancellation where supported |
| `idempotency` | Durable store with unique tenant + capability + version + key constraint |
| `effects` | Declared effects for audit/trace; not proof of business completion |

Use Jackson with strict unknown-field policy where appropriate, and a JSON Schema validator compatible with the protocol schema. DTO validation annotations may supplement, but MUST NOT silently replace, the published JSON Schema contract.

## 7. Transactions, idempotency and retries

- The Java domain service owns its database transaction and domain invariants.
- A write handler must use an idempotency record stored durably, not an in-memory map.
- Persist the idempotency key, canonical request fingerprint, status and serialized result under a unique constraint.
- Same key + same fingerprint returns the original result; same key + different fingerprint returns `IDEMPOTENCY_CONFLICT`.
- Do not automatically retry non-idempotent writes. Retry only when the capability contract and transport semantics allow it.
- For external side effects, use an outbox or equivalent reliable delivery pattern; do not claim a database rollback reverses an external payment/message.

## 8. Security and observability

- Authenticate service-to-service calls (OAuth2 client credentials or mTLS, depending on deployment).
- Derive tenant and roles from verified claims or a trusted gateway; never from arbitrary request JSON.
- Enforce app scope, capability permission and tenant isolation.
- Redact secrets and sensitive fields in logs.
- Propagate `requestId` and `traceId`; emit structured start/success/failure events and latency.
- Apply request size limits, timeouts, rate limits and bounded concurrency.
- Keep adapter registration server-side and allowlisted.

## 9. Java consumer client

The Java client should expose a typed call, not a generic method that bypasses protocol checks:

```java
A2ApiResult<EmployeeOutput> result = a2ApiClient.invoke(
    A2ApiInvocation.of("employee.create", "1.0.0", requestId, traceId,
                       appId, idempotencyKey, input),
    EmployeeOutput.class
);
```

The client sets protocol version, authenticates the service, propagates trace context, validates response envelope/version and maps protocol errors to typed exceptions/results. It must not allow a caller to set trusted identity claims.

## 10. Required conformance tests

1. Exact capability ID/version resolves; no implicit latest.
2. Unsupported protocol version is rejected.
3. Missing/invalid input and invalid handler output are rejected.
4. Unauthenticated caller, role mismatch, permission mismatch and tenant mismatch are rejected.
5. Duplicate registration fails at startup.
6. Same idempotency key/same payload replays; different payload conflicts, including concurrent requests.
7. Timeout and handler exception map to stable error envelopes.
8. Trace/request IDs propagate end-to-end.
9. Untrusted body tenant/role claims cannot elevate identity.
10. Published capability metadata cannot be mutated in place.

## 11. Delivery boundary

This document freezes the Java mapping design only. It does **not** claim that Maven modules, Spring Boot starter, provider endpoint, Java client or integration tests already exist. Implementation should begin with `a2api-java-core` and `a2api-java-testkit`, then the Spring Boot provider starter and typed client.
