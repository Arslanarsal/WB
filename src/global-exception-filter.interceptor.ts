import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

import { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  private isBaileysTimeoutError(exception: any): boolean {
    return (
      exception?.message?.includes('Timed Out') ||
      exception?.output?.statusCode === 408 ||
      (exception?.isBoom === true &&
        exception?.output?.payload?.error === 'Request Time-out') ||
      exception?.name === 'TimeoutError'
    );
  }

  private isFileSystemError(exception: any): boolean {
    return (
      exception?.code === 'ENOENT' ||
      exception?.message?.includes('no such file or directory') ||
      exception?.message?.includes('ENOENT')
    );
  }

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();

    if (this.isBaileysTimeoutError(exception)) {
      this.logger.warn(
        `Timeout exception handled: ${exception?.message || 'Unknown timeout'}`,
        `${request.method} ${request.url}`,
      );
    } else {
      this.logger.error(
        `Exception occurred: ${exception?.message || 'Unknown error'}`,
        exception?.stack,
        `${request.method} ${request.url}`,
      );
    }

    let statusCode: number;
    let errorMessage: string | string[];
    let errorDetails: any = null;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const errorResponse = exception.getResponse();
      errorMessage =
        typeof errorResponse === 'object' && 'message' in errorResponse
          ? (errorResponse['message'] as string | string[])
          : exception.message;
      errorDetails = typeof errorResponse === 'object' ? errorResponse : null;
    } else {
      if (this.isBaileysTimeoutError(exception)) {
        statusCode = HttpStatus.REQUEST_TIMEOUT;
        errorMessage =
          'WhatsApp connection timeout - service temporarily unavailable';
        this.logger.warn(
          'Baileys timeout error caught and handled gracefully',
          {
            originalError: exception?.message,
            statusCode: exception?.output?.statusCode,
          },
        );
      } else if (this.isFileSystemError(exception)) {
        statusCode = HttpStatus.BAD_REQUEST;
        errorMessage = 'Invalid media file path or file not found';
        this.logger.warn('File system error caught and handled gracefully', {
          originalError: exception?.message,
          filePath: exception?.path,
          errorCode: exception?.code,
        });
      } else {
        statusCode = exception?.status || HttpStatus.INTERNAL_SERVER_ERROR;
        errorMessage = exception?.message || 'Internal server error';
      }

      if (process.env.NODE_ENV !== 'production') {
        errorDetails = {
          name: exception?.name,
          stack: exception?.stack,
        };
      }
    }

    const messages = Array.isArray(errorMessage)
      ? errorMessage
      : [errorMessage];

    const errorResponse = {
      statusCode,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      error: {
        message: messages,
        ...(errorDetails && { details: errorDetails }),
      },
    };

    response.status(statusCode).json(errorResponse);
  }
}
