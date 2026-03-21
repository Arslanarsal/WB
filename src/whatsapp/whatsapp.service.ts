import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { SessionManager } from './session-manager';
import { WAPresence } from './whatsapp.controller';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class WhatsappService implements OnModuleInit {
  private readonly sessionsPath: string;

  constructor(
    private prisma: PrismaService,
    private manager: SessionManager,
  ) {}

  async onModuleInit() {
    try {
      console.log('Initializing WhatsApp service...');
      const sessionsFromDb = await this.prisma.whats_app_session.findMany({
        where: { serverId: Number(process.env.SERVER_ID) },
        select: { sessionId: true },
      });

      console.log(`Found ${sessionsFromDb.length} sessions to initialize`);

      for (const session of sessionsFromDb) {
        try {
          console.log(`Initializing session: ${session.sessionId}`);
          await this.manager.createSession(session.sessionId);
        } catch (sessionError: any) {
          console.error(
            `Failed to initialize session ${session.sessionId}:`,
            sessionError?.message || 'Unknown error',
          );
        }
      }

      console.log('WhatsApp service initialization completed');
    } catch (error: any) {
      console.error(
        'Error initializing WhatsApp service:',
        error?.message || 'Unknown error',
      );
    }
  }

  async connect(id: string, usePairingCode?: boolean, phoneNumber?: string) {
    try {
      const existingSession = this.manager.getSession(id);
      if (existingSession) {
        const sessionStatus = this.manager.getSessionStatus(id);

        if (sessionStatus.isActive) {
          console.log(
            `[${id}] Session already exists and is active. Returning existing session info.`,
          );
          return {
            id,
            sock: existingSession,
            message: `[${id}] Session already exists and is active.`,
            pairingCode: usePairingCode ? this.manager.getPairingCode(id)?.pairingCode : undefined,
          };
        } else {
          console.log(
            `[${id}] Session exists but is not active. Removing inactive session first.`,
          );
          await this.manager.removeSessionById(id);
        }
      }

      return await this.manager.createSession(id, usePairingCode, phoneNumber);
    } catch (error: any) {
      console.error(
        `Failed to connect session ${id}:`,
        error?.message || 'Unknown error',
      );
      throw error;
    }
  }

  async getPairingCode(sessionId: string) {
    return this.manager.getPairingCode(sessionId);
  }

  async sendText(
    id: string,
    number: string,
    message: string,
    isFromLid: boolean = false,
    mentions?: string[],
  ) {
    const sock = this.manager.getSession(id);
    if (!sock) throw new NotFoundException(`No active session for ${id}`);
    const remoteJid = isFromLid ? `${number}@lid` : `${number}@s.whatsapp.net`;
    try {
      const res = await sock.sendMessage(remoteJid, {
        text: message,
        mentions,
      });
      const wb_id =
        res && (res as any).key && (res as any).key.id != null
          ? (res as any).key.id
          : null;
      const body = { wb_id, text: message, at: new Date() };
      return body;
    } catch (error: any) {
      console.error(
        `Error sending text message to ${number}:`,
        error?.message || 'Unknown error',
      );
      return { wb_id: null, text: message, at: new Date() };
    }
  }

  async sendMedia(
    id: string,
    url: string,
    number: string,
    isVoiceMode = false,
    isFromLid: boolean = false,
    caption?: string,
    mentions?: string[],
  ): Promise<any> {
    try {
      if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
        throw new Error(
          `Invalid media URL format: ${url}. URL must start with http:// or https://`,
        );
      }

      const sock = this.manager.getSession(id);
      if (!sock) throw new Error(`No active session for ${id}`);
      const urlWithoutParams = url.split('?')[0];
      const urlParts = urlWithoutParams.split('.');
      const extension = urlParts[urlParts.length - 1].toLowerCase();

      const mimeTypes = {
        pdf: 'application/pdf',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        mp4: 'video/mp4',
        mp3: 'audio/mpeg',
        ogg: 'audio/ogg; codecs=opus',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xls: 'application/vnd.ms-excel',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ppt: 'application/vnd.ms-powerpoint',
        txt: 'text/plain',
        rtf: 'application/rtf',
        csv: 'text/csv',
        json: 'application/json',
        zip: 'application/zip',
        dcm: 'application/dicom',
      };

      enum MediaType {
        PDF = 'application/pdf',
        JPG = 'image/jpeg',
        JPEG = 'image/jpeg',
        PNG = 'image/png',
        MP4 = 'video/mp4',
        MP3 = 'audio/mpeg',
        OGG = 'audio/ogg; codecs=opus',
        DOC = 'application/msword',
        DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        XLS = 'application/vnd.ms-excel',
        PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        PPT = 'application/vnd.ms-powerpoint',
        TXT = 'text/plain',
        RTF = 'application/rtf',
        CSV = 'text/csv',
        ZIP = 'application/zip',
        DCM = 'application/dicom',
        JSON = 'application/json',
      }

      const mimeType = mimeTypes[extension] || 'application/octet-stream';

      const remoteJid = isFromLid ? `${number}@lid` : `${number}@s.whatsapp.net`;

      const res = await (() => {
        if (mimeType === MediaType.PDF) {
          return sock.sendMessage(remoteJid, {
            document: { url: url },
            mimetype: mimeType,
            caption,
            mentions,
          });
        } else if (
          mimeType === MediaType.JPG ||
          mimeType === MediaType.JPEG ||
          mimeType === MediaType.PNG
        ) {
          return sock.sendMessage(remoteJid, {
            image: { url: url },
            mimetype: mimeType,
            caption,
            mentions,
          });
        } else if (mimeType === MediaType.MP4) {
          return sock.sendMessage(remoteJid, {
            video: { url: url },
            mimetype: mimeType,
            caption,
            mentions,
          });
        } else if (mimeType === MediaType.MP3) {
          return sock.sendMessage(remoteJid, {
            audio: { url: url },
            mimetype: mimeType,
            caption,
            mentions,
          });
        } else if (mimeType === MediaType.OGG) {
          return sock.sendMessage(remoteJid, {
            audio: { url: url },
            mimetype: mimeType,
            ptt: isVoiceMode,
            mentions,
          });
        } else {
          return sock.sendMessage(remoteJid, {
            document: { url: url },
            mimetype: mimeType,
            mentions,
          });
        }
      })();

      const wb_id =
        res && (res as any).key && (res as any).key.id != null
          ? (res as any).key.id
          : null;
      const body = { wb_id, url, caption, mimeType, at: new Date() };

      console.log(`Media sent successfully to ${number}`);
      return body;
    } catch (error) {
      console.error(`Error sending media to ${number}:`, error);
      return { wb_id: null, url, caption, mimeType: 'error', at: new Date() };
    }
  }

  async listSessions() {
    return await this.manager.listSessions();
  }
  getSessionStatus(id: string) {
    return this.manager.getSessionStatus(id);
  }
  async listConnectedSessions() {
    return await this.manager.listAllConnectedSessions();
  }
  async removeSessionById(id: string) {
    return this.manager.removeSessionById(id);
  }

  async removeAllInactiveSessions() {
    return this.manager.removeAllInactiveSessions();
  }

  async listAllDisconnectedSessions() {
    return this.manager.listAllDisconnectedSessions();
  }

  async getQrCodeImage(id: string): Promise<Buffer | null> {
    const imageBuffer = await this.manager.getQrCodeImage(id);
    if (!imageBuffer)
      throw new NotFoundException(
        'QR Code not found or session already connected',
      );
    return imageBuffer;
  }
  async getQrCode(sessionId: string) {
    return this.manager.getQrCode(sessionId);
  }

  async mockTyping(id: string, number: string, presence: WAPresence) {
    return await this.manager.mockTyping(id, number, presence);
  }

  async clearMockTyping(id: string, number: string) {
    return await this.manager.clearMockTyping(id, number);
  }

  async isOnWhatsApp(id: string, number: string) {
    return await this.manager.checkNumberOnWhatsApp(id, number);
  }

  async isOnWhatsAppWithLid(id: string, number: string) {
    return await this.manager.checkNumberOnWhatsAppV2(id, number);
  }

  async getProfilePic(id: string, number: string) {
    return await this.manager.getProfileUrl(id, number);
  }
}
