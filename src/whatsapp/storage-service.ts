import { Injectable, Logger } from '@nestjs/common';
import { StorageClient } from '@supabase/storage-js';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StorageService {
  private storageClient: StorageClient;
  private readonly logger = new Logger(StorageService.name);

  constructor(private configService: ConfigService) {
    const storageUrl = this.configService.get<string>('SUPABASE_STORAGE_URL');
    const serviceKey = this.configService.get<string>('SUPABASE_SERVICE_KEY');

    if (!storageUrl || !serviceKey) {
      throw new Error('Missing required Supabase configuration');
    }

    const normalizedUrl = storageUrl.replace(/\/+$/, '').endsWith('/storage/v1')
      ? storageUrl.replace(/\/+$/, '')
      : `${storageUrl.replace(/\/+$/, '')}/storage/v1`;

    this.storageClient = new StorageClient(normalizedUrl, {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    });
  }

  async upload(
    fileName: string,
    imageBuffer: Buffer,
    bucketName: string,
    contentType: string,
  ): Promise<string | null> {
    try {
      const timestamp = Date.now();
      const lastSlash = fileName.lastIndexOf('/');
      const uniqueFileName =
        lastSlash >= 0
          ? `${fileName.substring(0, lastSlash + 1)}${timestamp}-${fileName.substring(lastSlash + 1)}`
          : `${timestamp}-${fileName}`;

      const { data, error } = await this.storageClient
        .from(bucketName)
        .upload(uniqueFileName, imageBuffer, {
          upsert: true,
          contentType: contentType,
        });

      if (error) {
        this.logger.log('Failed to upload file to Supabase:', {
          parameters: { fileName, imageBuffer, bucketName, contentType },
          error,
        });
        return null;
      }

      const {
        data: { publicUrl },
      } = this.storageClient.from(bucketName).getPublicUrl(uniqueFileName);

      return publicUrl;
    } catch (error) {
      this.logger.error('Failed to upload file to Supabase:', {
        parameters: { fileName, imageBuffer, bucketName, contentType },
        error,
      });
      throw error;
    }
  }
  getMediaExtension(mimeType: string): string {
    return (
      {
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
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
          'docx',
        'application/vnd.ms-excel': 'xls',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
          'xlsx',
        'application/vnd.ms-powerpoint': 'ppt',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation':
          'pptx',
      }[mimeType] || ''
    );
  }
  async uploadMedia(
    media: any,
    company: string,
    contact: string,
  ): Promise<string | null> {
    try {
      if (media?.hasMedia && media?.mimeType && media?.buffer) {
        const bucketName = 'ChatPilot-media';
        const filePath = `${company}/${contact}/media.${this.getMediaExtension(media.mimeType)}`;
        const mediaUrl = await this.upload(
          filePath,
          Buffer.from(media?.buffer),
          bucketName,
          media?.mimeType,
        );
        return mediaUrl;
      }
      return null;
    } catch (error) {
      this.logger.error('uploadMedia failed', {
        context: 'uploadMedia',
        parameters: { media, company, contact },
        result: null,
        error,
      });
      return null;
    }
  }
}
