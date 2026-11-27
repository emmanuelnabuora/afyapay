import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MaskingLogger } from './common/masking-logger';
import { resolveEnvironment } from './environment';
import { authSecret } from './modules/identity/tokens';

async function bootstrap(): Promise<void> {
  resolveEnvironment(); // refuses to start in an environment that is not allowed yet
  authSecret(); // fails fast if AUTH_SECRET is missing or too short
  const app = await NestFactory.create(AppModule, { logger: new MaskingLogger('AfyaPay', { json: true }) });
  app.setGlobalPrefix('v1');
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
