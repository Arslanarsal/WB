import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly uploadUrl: string;

  constructor(private configService: ConfigService) {
    const webhookUrl = this.configService.get<string>('WEBHOOK_URL');
    if (!webhookUrl) {
      throw new Error('Missing WEBHOOK_URL configuration');
    }
    // WEBHOOK_URL is like http://localhost:3000/api/v1/webhook/whats-bailey
    // We need http://localhost:3000/api/v1/webhook/upload-media
    this.uploadUrl = webhookUrl.replace(/\/whats-bailey$/, '/upload-media');
  }

  private static readonly MIME_EXTENSIONS: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/pjpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'audio/aac': 'aac',
    'audio/m4a': 'm4a',
    'audio/amr': 'amr',
    'audio/mpeg': 'mp3',
    'audio/ogg; codecs=opus': 'ogg',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'text/plain': 'txt',
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  };

  getMediaExtension(mimeType: string): string {
    return StorageService.MIME_EXTENSIONS[mimeType] || '';
  }

  async uploadMedia(
    media: any,
    company: string,
    contact: string,
  ): Promise<string | null> {
    try {
      if (media?.hasMedia && media?.mimeType && media?.buffer) {
        const response = await axios.post(
          this.uploadUrl,
          {
            mediaBuffer: Array.from(Buffer.from(media.buffer)),
            mimeType: media.mimeType,
            companyPhone: company,
            contactPhone: contact,
          },
          {
            timeout: 60000,
            headers: { 'Content-Type': 'application/json' },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          },
        );

        if (response.data?.success && response.data?.mediaUrl) {
          this.logger.log(`Media uploaded via ChatPilot: ${response.data.mediaUrl}`);
          return response.data.mediaUrl;
        }

        this.logger.warn('ChatPilot upload returned no URL', { response: response.data });
        return null;
      }
      return null;
    } catch (error) {
      this.logger.error('uploadMedia via ChatPilot failed', {
        error: error.message,
        company,
        contact,
      });
      return null;
    }
  }
}
