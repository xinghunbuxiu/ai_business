package dev.aibusiness.a2api;

import org.springframework.security.core.Authentication;

/**
 * Maps an already-authenticated Spring Security principal to A2API identity.
 * Implementations must derive tenant/roles/permissions from verified claims or
 * trusted server-side authorization data, never from the invocation JSON body.
 */
public interface A2ApiIdentityResolver {
    A2ApiIdentity resolve(Authentication authentication);
}
