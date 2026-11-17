package dev.aibusiness.a2api;

public record A2ApiError(String code, String message, boolean retryable) {}
