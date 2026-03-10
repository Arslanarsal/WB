import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded } from 'express';

async function bootstrap() {
  try {
    const app = await NestFactory.create(AppModule);
    const configService = app.get(ConfigService);

    // Configure body parser limits
    app.use(json({ limit: '50mb' }));
    app.use(urlencoded({ limit: '50mb', extended: true }));

    app.setGlobalPrefix('api/v1');
    // if (configService.get('NODE_ENV') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Balieys-API')
      .addCookieAuth()
      .setDescription('Balieys API Services')
      .setExternalDoc('Postman Collection', '/api-json')
      .setVersion('1.0')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api', app, document);
    // }

    const port = configService.get('PORT', 3000);
    await app.listen(port);
    console.log(`🚀 Application is running on: http://localhost:${port}/api`);
  } catch (error) {
    console.error('❌ Error starting application:', error);
    process.exit(1);
  }
}

// Handle unhandled promise rejections (like Baileys timeout errors)
process.on('unhandledRejection', (reason: any, promise) => {
  console.error('🔥 Unhandled Promise Rejection at:', promise);
  console.error('Reason:', reason?.message || reason);

  // Check if it's a Baileys timeout error
  if (
    reason?.message?.includes('Timed Out') ||
    reason?.output?.statusCode === 408
  ) {
    console.warn(
      '⏱️  WhatsApp timeout error detected - continuing operation...',
    );
  } else {
    console.error(
      '❌ Critical unhandled rejection - application may be unstable',
    );
  }

  // Don't exit the process for timeout errors, just log them
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('🔥 Uncaught Exception:', error.message);
  console.error('Stack:', error.stack);

  // Check if it's a Baileys timeout error
  if (error.message?.includes('Timed Out')) {
    console.warn(
      '⏱️  WhatsApp timeout error detected as uncaught exception - continuing...',
    );
  } else if (
    (error as any).code === 'ENOENT' &&
    error.message?.includes('no such file or directory')
  ) {
    // Handle file not found errors - don't crash the server
    console.warn('📁 File not found error detected - continuing operation...');
    console.warn('File path attempted:', (error as any).path);
  } else {
    console.error('❌ Critical uncaught exception - exiting process');
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('👋 Received SIGINT, shutting down gracefully');
  process.exit(0);
});

bootstrap();
