package dev.aibusiness.a2api;

public interface A2ApiHandler<I, O> {
    String capabilityId();
    String capabilityVersion();
    Class<I> inputType();
    O handle(I input, A2ApiContext context);
}
