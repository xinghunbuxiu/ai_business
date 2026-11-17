package dev.aibusiness.a2api;

import static org.junit.jupiter.api.Assertions.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

class A2ApiHandlerRegistryTest {
    record Input(String name) {}
    record Output(String employeeId) {}

    static final class CreateEmployee implements A2ApiHandler<Input, Output> {
        public String capabilityId() { return "hr.employee.create"; }
        public String capabilityVersion() { return "1.0.0"; }
        public Class<Input> inputType() { return Input.class; }
        public java.util.Set<String> requiredRoles() { return java.util.Set.of("hr_admin"); }
        public java.util.Set<String> requiredPermissions() { return java.util.Set.of("employee:create"); }
        public boolean tenantRequired() { return true; }
        public boolean idempotencyRequired() { return true; }
        public Output handle(Input input, A2ApiContext context) {
            assertEquals("tenant-a", context.identity().tenantId());
            return new Output("emp-1");
        }
    }

    @Test
    void invokesOnlyAnExactCapabilityVersion() throws Exception {
        var registry = new A2ApiHandlerRegistry(List.of(new CreateEmployee()), new ObjectMapper());
        var identity = new A2ApiIdentity("user-1", "tenant-a", java.util.Set.of("hr_admin"), java.util.Set.of("employee:create"));
        var context = new A2ApiContext(identity, "hr-app", "req-1", "trace-1", "idem-1");
        var invocation = new A2ApiInvocation("1.0.0", "hr.employee.create", "1.0.0", "req-1", "trace-1", "hr-app", "idem-1", new ObjectMapper().readTree("{\"name\":\"Alex\"}"));
        var output = registry.invoke(invocation, context);
        assertEquals("emp-1", output.get("employeeId").asText());

        var deniedIdentity = new A2ApiIdentity("user-2", "tenant-a", java.util.Set.of("consumer"), java.util.Set.of());
        var deniedContext = new A2ApiContext(deniedIdentity, "hr-app", "req-1", "trace-1", "idem-1");
        var denied = assertThrows(A2ApiException.class, () -> registry.invoke(invocation, deniedContext));
        assertEquals("FORBIDDEN", denied.code());

        var missingKey = new A2ApiInvocation("1.0.0", "hr.employee.create", "1.0.0", "req-3", "trace-3", "hr-app", null, new ObjectMapper().readTree("{\"name\":\"Alex\"}"));
        var missingKeyError = assertThrows(A2ApiException.class, () -> registry.invoke(missingKey, context));
        assertEquals("IDEMPOTENCY_KEY_REQUIRED", missingKeyError.code());

        var missingVersion = new A2ApiInvocation("1.0.0", "hr.employee.create", "2.0.0", "req-2", "trace-2", "hr-app", "idem-2", new ObjectMapper().readTree("{\"name\":\"Alex\"}"));
        var error = assertThrows(A2ApiException.class, () -> registry.invoke(missingVersion, context));
        assertEquals("CAPABILITY_NOT_FOUND", error.code());
    }

    @Test
    void rejectsDuplicateHandlerPinsAtStartup() {
        assertThrows(IllegalStateException.class, () -> new A2ApiHandlerRegistry(List.of(new CreateEmployee(), new CreateEmployee()), new ObjectMapper()));
    }
}
