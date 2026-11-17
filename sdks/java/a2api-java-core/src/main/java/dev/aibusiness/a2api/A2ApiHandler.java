package dev.aibusiness.a2api;

import java.util.Set;

public interface A2ApiHandler<I, O> {
    String capabilityId();
    String capabilityVersion();
    Class<I> inputType();

    /** At least one required role must match the verified caller identity. */
    Set<String> requiredRoles();

    /** Every listed permission must be present on the verified caller identity. */
    Set<String> requiredPermissions();

    /** Whether the verified identity must contain a tenant ID. */
    boolean tenantRequired();

    O handle(I input, A2ApiContext context);
}
