import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { requestContextMiddleware } from './modules/operational/request-context.middleware.js';
import { requestObservabilityMiddleware } from './modules/operational/request-observability.middleware.js';
import { MetricsService } from './modules/operational/metrics.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);

  if (process.env.NODE_ENV === 'production') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.use(requestContextMiddleware);
  app.use(requestObservabilityMiddleware(app.get(MetricsService)));
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });
  app.enableShutdownHooks();

  await app.listen(port);
}

void bootstrap();
