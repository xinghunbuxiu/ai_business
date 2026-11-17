package dev.aibusiness.a2api;

import java.util.Set;

public record A2ApiIdentity(String userId, String tenantId, Set<String> roles, Set<String> permissions) {
    public A2ApiIdentity {
        roles = roles == null ? Set.of() : Set.copyOf(roles);
        permissions = permissions == null ? Set.of() : Set.copyOf(permissions);
    }
}
