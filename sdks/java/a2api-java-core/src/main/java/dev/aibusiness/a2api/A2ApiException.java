package dev.aibusiness.a2api;

public class A2ApiException extends RuntimeException {
    private final String code;
    private final boolean retryable;

    public A2ApiException(String code, String message, boolean retryable) {
        super(message);
        this.code = code;
        this.retryable = retryable;
    }

    public String code() { return code; }
    public boolean retryable() { return retryable; }
}
