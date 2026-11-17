package dev.aibusiness.a2api.spring;

import dev.aibusiness.a2api.*;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration(proxyBeanMethods = false)
@ConditionalOnBean(A2ApiIdentityResolver.class)
public class A2ApiProviderConfiguration {
    @Bean
    A2ApiHandlerRegistry a2ApiHandlerRegistry(List<A2ApiHandler<?, ?>> handlers, ObjectMapper objectMapper) {
        return new A2ApiHandlerRegistry(handlers, objectMapper);
    }

    @Bean
    A2ApiProviderController a2ApiProviderController(A2ApiHandlerRegistry registry, A2ApiIdentityResolver identityResolver) {
        return new A2ApiProviderController(registry, identityResolver);
    }
}
