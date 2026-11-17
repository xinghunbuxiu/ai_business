package dev.aibusiness.a2api;

/**
 * Framework-neutral identity mapping contract. The Spring adapter passes the
 * authenticated principal object supplied by the host security framework.
 * Implementations must derive claims from verified authentication state.
 */
public interface A2ApiIdentityResolver {
    A2ApiIdentity resolve(Object authenticatedPrincipal);
}
