// Polyfill crypto for Baileys
import { webcrypto } from 'node:crypto';
if (!global.crypto) {
  (global as any).crypto = webcrypto;
}

import {
  makeWASocket,
  DisconnectReason,
  WASocket,
  downloadMediaMessage,
  WAPresence,
  fetchLatestWaWebVersion,
} from '@whiskeysockets/baileys';
import * as qrcode from 'qrcode';
import axios from 'axios';
import { Injectable, NotFoundException , Logger } from '@nestjs/common';
import { createPrismaAuthState } from './helpers/prisma-auth-state';
import { StorageService } from './storage-service';
import { PrismaService } from '../prisma/prisma.service';

type Session = {
  id: string;
  sock: WASocket;
  connectionStatus?: string;
  lastDisconnectError?: any;
};

@Injectable()
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private qrCodes = new Map<string, string>();
  private reconnectionAttempts = new Map<string, number>();
  private readonly maxReconnectionAttempts = 5;
  private readonly logger = new Logger(SessionManager.name);

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
  ) {}

  async createSession(
    id: string,
  ): Promise<Session> {
    try {
      this.logger.log(`[${id}] Creating WhatsApp session...`);
      const { state, saveCreds } = await createPrismaAuthState(id, this.prisma);
      const { version, isLatest } = await fetchLatestWaWebVersion({});
      const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        connectTimeoutMs: 60000, 
        defaultQueryTimeoutMs: 60000, 
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 1000, 
        maxMsgRetryCount: 3, 
        qrTimeout: 60000,
        markOnlineOnConnect: true,
      });

      sock.ev.on('creds.update', (creds) => {
        try {
          saveCreds();
        } catch (error: any) {
          this.logger.error(
            `[${id}] Error saving credentials:`,
            error?.message || 'Unknown error',
          );
        }
      });

      sock.ev.on('connection.update', (update) => {
        try {
          this.handleConnectionUpdate(id, update, sock);
        } catch (error: any) {
          this.logger.error(
            `[${id}] Error in connection update:`,
            error?.message || 'Unknown error',
          );
        }
      });

      // Wrap socket operations in try-catch for error handling
      this.wrapSocketWithErrorHandling(id, sock);

      sock.ev.on('messages.upsert', async (m) => {
        try {
          await this.handleMessagesUpsert(id, m, sock);
        } catch (error: any) {
          this.logger.error(
            `[${id}] Error handling messages:`,
            error?.message || 'Unknown error',
          );

        }
      });
      if (process.env.ENABLE_MESSAGE_RECEIPT === 'true') {
        sock.ev.on('messages.update', async (messageUpdates) => {
          const status = {
            2: 'sent',
            3: 'delivered',
            4: 'read',
            5: 'read',
          };
          const messageId = messageUpdates[0].key.id;
          const fromMe = messageUpdates[0].key.fromMe;
          const update = messageUpdates[0].update;
          if (update.hasOwnProperty('status')) {
            const body = {
              id: messageId,
              hasStatus: true,
              status: status[update.status as any],
              at: new Date(),
              fromMe,
            };

            if (update.status && update.status > 2) {
              this.logger.log(` Message status update`, { session: id, body });
              this.sendUpdateMessageHookWithRetry(body);
            }
          }
          // // Check for conversation string in various possible nested locations, safely
          // else if (
          //   update &&
          //   typeof update === 'object' &&
          //   update.hasOwnProperty('message') &&
          //   (
          //     // Direct conversation
          //     (update.message && typeof update.message.conversation === 'string') ||
          //     // Nested: message.editedMessage.message.conversation
          //     (update.message?.editedMessage?.message && typeof update.message.editedMessage.message.conversation === 'string')
          //   )
          // ) {
          //   const body = { id:messageId,hasStatus : false, conversation:update.message.conversation, at: new Date()}
          //   this.logger.log(` Message update body: ${JSON.stringify(body)}`);
          //   await this.sendUpdateMessageHookWithRetry(body);
          // }
        });
      }
      const session: Session = {
        id,
        sock,
      };
      this.sessions.set(id, session);

      // Log phone number if available in auth state
      const sessionPhone =sock?.user?.id?.split(':')[0] || 'Pending authentication';

      this.logger.log(
        `[${id}] ✅ Session created successfully${sock?.user ? `, Phone: ${sessionPhone}` : ' (awaiting connection)'}`,
      );
      return session;
    } catch (error: any) {
      this.logger.error(
        `[${id}] Error creating session:`,
        error?.message || 'Unknown error',
      );
     
      if (this.sessions.has(id)) {
        this.sessions.delete(id);
      }
      throw error;
    }
  }

  private async handleConnectionUpdate(id: string, update: any, sock: any) {
    const { connection, lastDisconnect, qr } = update;


    const session = this.sessions.get(id);
    if (session) {
      session.connectionStatus = connection;
      if (lastDisconnect?.error) {
        session.lastDisconnectError = lastDisconnect.error;
      }
    }

    if (connection === 'open' || connection === 'close') {
      this.notifyApiOfStatusChange(id, connection, sock, lastDisconnect).catch(
        (err) => {
          this.logger.error('status-api', {
            context: 'handleConnectionUpdate',
            error: err.message,
            parameters: { id, connection, lastDisconnect },
          });
        },
      );
    }
    if (qr) {
      this.qrCodes.set(id, qr);
      this.logger.log(`[${id}] QR code generated (terminal display disabled)`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isTimeout =
        statusCode === 408 || errorMessage?.includes('Timed Out');
      const isConnectionLost = statusCode === DisconnectReason.connectionLost;

      this.logger.log(
        `[${id}] Connection closed. Status: ${statusCode}, Message: ${errorMessage}`,
      );

      if (isLoggedOut) {
        this.logger.log(
          `[${id}] ❌ Session logged out from mobile. Removing session.`,
        );
        this.removeSessionById(id);
        return;
      }

      // Handle reconnection with exponential backoff
      const attempts = this.reconnectionAttempts.get(id) || 0;
      if (attempts < this.maxReconnectionAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempts), 30000); 
        this.logger.log(
          `[${id}] Connection failed (attempt ${attempts + 1}/${this.maxReconnectionAttempts}). Retrying in ${delay}ms...`,
        );

        setTimeout(() => {
          this.reconnectionAttempts.set(id, attempts + 1);
          this.createSession(id).catch((error) => {
            this.logger.error(
              `[${id}] Reconnection failed:`,
              error?.message || 'Unknown error',
            );
          });
        }, delay);
      } else {
        this.logger.error(
          `[${id}] ❌ Max reconnection attempts reached. Removing session.`,
        );
        this.reconnectionAttempts.delete(id);
        this.removeSessionById(id);
      }
    }

    if (connection === 'open') {
      const phoneNumber = sock.user?.id?.split(':')[0] || 'Unknown';
      this.logger.log(`[${id}] ✅ WhatsApp connected! Phone: ${phoneNumber}`);
      this.reconnectionAttempts.delete(id); // Reset attempts on successful connection
      
    }
  }

  private wrapSocketWithErrorHandling(id: string, sock: any) {
    // Wrap critical socket methods with error handling
    const originalSendMessage = sock.sendMessage;
    sock.sendMessage = async (...args: any[]) => {
      try {
        return await originalSendMessage.apply(sock, args);
      } catch (error: any) {
        this.logger.error(
          `[${id}] Send message error:`,
          error?.message || 'Unknown error',
        );
        if (
          error?.message?.includes('Timed Out') ||
          error?.output?.statusCode === 408
        ) {
          this.logger.warn(
            `[${id}] ⏱️  Timeout in send message, connection may be unstable`,
          );
        }
        throw error;
      }
    };

    // Wrap query method
    const originalQuery = sock.query;
    if (originalQuery) {
      sock.query = async (...args: any[]) => {
        try {
          return await originalQuery.apply(sock, args);
        } catch (error: any) {
          this.logger.error(
            `[${id}] Query error:`,
            error?.message || 'Unknown error',
          );
          if (
            error?.message?.includes('Timed Out') ||
            error?.output?.statusCode === 408
          ) {
            this.logger.warn(`[${id}] ⏱️  Query timeout detected`);
          }
          throw error;
        }
      };
    }
  }

 

  private async handleMessagesUpsert(id: string, m: any, sock: any) {
    const { type, messages } = m;

    if (!messages || messages.length === 0) return;

    // Validate session is still active before processing messages
    if (!this.getSession(id)) {
      this.logger.warn(
        `[${id}] Session no longer active, skipping message processing`,
      );
      return;
    }

    for (const message of messages) {
      try {
        if (
          message?.key?.remoteJid?.endsWith('@g.us') ||
          message?.key?.remoteJid?.endsWith('@broadcast') ||
          message?.key?.remoteJid?.endsWith('@lid')
        )
          continue;

        const remoteJid = message?.key?.remoteJid;
        if (remoteJid) {
          const remoteid = remoteJid.split('@')[0];
          message.key['userPhone'] = remoteid;
          message.key['companyPhone'] = sock.user?.id.split(':')[0];
        }
        if (message.key['userPhone'] === message.key['companyPhone']) {
          continue;
        }

        const payload = await this.messageHandler(message);
       
        if (payload.shouldNotifyWebhook) {
          // const reply = message.message.conversation;
          await this.sendWebhookWithRetry(payload);
          // await sock.sendMessage(remoteJid, { text: reply });
        }
      } catch (messageError: any) {
        this.logger.error(
          `[${id}] Error processing message ${message?.key?.id}:`,
          messageError?.message || 'Unknown error',
        );
        // Continue processing other messages even if one fails
      }
    }
  }

  private async sendUpdateMessageHookWithRetry(
    payload: any,
    maxRetries: number = 1,
    delay: number = 1000,
  ): Promise<void> {
    const webhookUrl = process.env.WEBHOOK_URL as string;

    if (!webhookUrl) {
      console.warn('WEBHOOK_URL not configured, skipping webhook call');
      return;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use shorter timeout since media is now uploaded to storage (no large buffers)
        const response = await axios.post(
          `${webhookUrl}/message-update`,
          payload,
          {
            timeout: 50000, // 30 second timeout
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'WhatsApp-Bot/1.0',
            },
            // Prevent axios from throwing on HTTP error status codes
            validateStatus: (status) => status < 500, // Only retry on 5xx errors
          },
        );

        if (response.status >= 200 && response.status < 300) {
          console.log(`Webhook sent successfully on attempt ${attempt}`);
          return;
        } else {
          console.warn(
            `Webhook returned status ${response.status} on attempt ${attempt}`,
          );
          if (response.status < 500) {
            // Don't retry 4xx errors (client errors)
            return;
          }
        }
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const shouldRetry = this.isRetryableError(error);

        console.error(`Webhook attempt ${attempt} failed:`, {
          message: error.message,
          code: error.code,
          status: error.response?.status,
        });

        if (isLastAttempt || !shouldRetry) {
          console.error(
            `Failed to send webhook after ${attempt} attempts. Final error:`,
            error.message,
          );
          return;
        }

        // Exponential backoff with jitter
        const backoffDelay =
          delay * Math.pow(2, attempt - 1) + Math.random() * 1000;
        console.log(`Retrying webhook in ${Math.round(backoffDelay)}ms...`);
        await this.sleep(backoffDelay);
      }
    }
  }
  private async sendWebhookWithRetry(
    payload: any,
    maxRetries: number = 3,
    delay: number = 1000,
  ): Promise<void> {
    const webhookUrl = process.env.WEBHOOK_URL as string;

    if (!webhookUrl) {
      console.warn('WEBHOOK_URL not configured, skipping webhook call');
      return;
    }

    // Calculate and log payload size
    // const payloadSizeInfo = this.calculatePayloadSize(payload);
    // if (!payloadSizeInfo.isAllowed) {
    //   console.warn(
    //     `Payload is too large, skipping webhook call because it exceeds 50MB ${payloadSizeInfo.mediaBufferSizeMB}`,
    //   );
    //   return;
    // }

    // // Show warning for large payloads
    // if (payloadSizeInfo.sizeWarning) {
    //   console.warn(payloadSizeInfo.sizeWarning);
    // }

    // Upload large media files to storage and replace buffer with URL
    if (payload.hasMedia) {
      try {
        const mediaObject = {
          hasMedia: true,
          mimeType: payload.mediaType,
          buffer: payload.mediaBuffer,
        };

        const company = payload.companyPhone || 'default';
        const contact = payload.userPhone || 'unknown';

        // console.log(
        //   `Uploading media to storage: ${payloadSizeInfo.mediaBufferSizeMB}`,
        // );
        const mediaUrl = await this.storageService.uploadMedia(
          mediaObject,
          company,
          contact,
        );

        if (mediaUrl) {
          // Replace the buffer with the URL and add size info
          payload.mediaUrl = mediaUrl;
          payload.mediaSize = payload.mediaBuffer.length;
          console.log(`✅ Media uploaded successfully: ${mediaUrl}`);
        } else {
          console.warn('⚠️  Media upload failed, sending without media buffer');
        }
      } catch (error) {
        console.error('❌ Media upload error:', error.message);
      }
    }
    if (payload.hasMedia && !payload.isAudio) {
      // Remove buffer if it's not an audio file
      delete payload.mediaBuffer;
    }
    console.log('Sending payload to webhook:', payload);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Use shorter timeout since media is now uploaded to storage (no large buffers)
        const response = await axios.post(webhookUrl, payload, {
          timeout: 50000, // 30 second timeout
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'WhatsApp-Bot/1.0',
          },
          // Prevent axios from throwing on HTTP error status codes
          validateStatus: (status) => status < 500, // Only retry on 5xx errors
        });

        if (response.status >= 200 && response.status < 300) {
          console.log(`Webhook sent successfully on attempt ${attempt}`);
          return;
        } else {
          console.warn(
            `Webhook returned status ${response.status} on attempt ${attempt}`,
          );
          if (response.status < 500) {
            // Don't retry 4xx errors (client errors)
            return;
          }
        }
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;
        const shouldRetry = this.isRetryableError(error);

        console.error(`Webhook attempt ${attempt} failed:`, {
          message: error.message,
          code: error.code,
          status: error.response?.status,
        });

        if (isLastAttempt || !shouldRetry) {
          console.error(
            `Failed to send webhook after ${attempt} attempts. Final error:`,
            error.message,
          );
          return;
        }

        // Exponential backoff with jitter
        const backoffDelay =
          delay * Math.pow(2, attempt - 1) + Math.random() * 1000;
        console.log(`Retrying webhook in ${Math.round(backoffDelay)}ms...`);
        await this.sleep(backoffDelay);
      }
    }
  }

  private isRetryableError(error: any): boolean {
    // Retry on network errors and 5xx server errors
    const retryableCodes = [
      'ECONNRESET',
      'ENOTFOUND',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ECONNABORTED',
    ];
    const isNetworkError = retryableCodes.includes(error.code);
    const is5xxError = error.response?.status >= 500;

    return isNetworkError || is5xxError;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private calculatePayloadSize(payload: any): {
    totalSizeBytes?: number;
    totalSizeMB?: string;
    mediaBufferSizeBytes?: number;
    mediaBufferSizeMB?: string;
    sizeWarning?: string;
    isAllowed: boolean;
  } {
    const result: any = {
      isAllowed: true,
    };

    // Calculate mediaBuffer size separately if it exists
    if (payload.mediaBuffer && Buffer.isBuffer(payload.mediaBuffer)) {
      const mediaBufferSizeBytes = payload.mediaBuffer.length;
      const mediaBufferSizeMB = (mediaBufferSizeBytes / (1024 * 1024)).toFixed(
        2,
      );

      result.mediaBufferSizeBytes = mediaBufferSizeBytes;
      result.mediaBufferSizeMB = `${mediaBufferSizeMB} MB`;

      // Add warnings for large payloads
      if (mediaBufferSizeBytes > 50 * 1024 * 1024) {
        // 50MB
        result.sizeWarning = `⚠️  LARGE PAYLOAD: MediaBuffer is ${mediaBufferSizeMB} MB - uploading to storage instead`;
        result.isAllowed = false;
      } else if (mediaBufferSizeBytes > 10 * 1024 * 1024) {
        // 10MB
        result.sizeWarning = `⚡ Large media file: ${mediaBufferSizeMB} MB - will upload to storage`;
        result.isAllowed = true;
      }
    }

    return result;
  }

  private async messageHandler(data: any): Promise<{
    fromMe: boolean;
    id: string;
    userPhone: string | null;
    companyPhone: string;
    shouldNotifyWebhook: boolean;
    isAudio: boolean;
    hasMedia: boolean;
    hasDocument: boolean;
    text?: string;
    info?: string;
    mediaInfo?: any;
    meta?: any;
    senderName?: string;
    quotedMessageId?: string | null;
  }> {
    const payload: any = {
      quotedMessageId:
      data?.message?.extendedTextMessage?.contextInfo?.stanzaId ?? null,
      fromMe: data.key.fromMe,
      id: data.key.id,
      userPhone: data.key.userPhone,
      companyPhone: data.key.companyPhone,
      shouldNotifyWebhook: true,
      isAudio: false,
      hasMedia: false,
      hasDocument: false,
      hasLocation: false,
      senderName: data.pushName,
      externalAdReply:
        data?.message?.extendedTextMessage?.contextInfo?.externalAdReply ??
        null,
    };
    try {
      if (
        data.key.fromMe == false ||
        (data.key.fromMe && data.hasOwnProperty('broadcast'))
      ) {
        const message = data.message;
        const prefix = data.key.fromMe ? 'company' : 'client';
        // Object.hasOwnProperty.call(message, 'conversation') && (payload.text = message.conversation);
        if (message.hasOwnProperty('extendedTextMessage')) {
          payload.text = message?.extendedTextMessage?.text;
          payload.info = `<> ${prefix} reply message`;
        } else if (message.hasOwnProperty('audioMessage')) {
          payload.isAudio = true;
          // payload.mediaInfo = data;
          payload.hasMedia = true;
          payload.mediaBuffer = await downloadMediaMessage(data, 'buffer', {});
          payload.mediaType = message.audioMessage.mimetype;
          payload.info = `<> ${prefix} audio/audio reply message`;
        } else if (message.hasOwnProperty('documentWithCaptionMessage')) {
          payload.hasDocument = true;
          payload.hasMedia = true;
          // payload.mediaInfo = data;
          payload.mediaBuffer = await downloadMediaMessage(data, 'buffer', {});
          payload.mediaType = message.documentWithCaptionMessage.mimetype;
          payload.text = message.documentWithCaptionMessage.message.documentMessage.caption;
          payload.info = `<> ${prefix} PDF with caption message`;
        } else if (message.hasOwnProperty('imageMessage')) {
          payload.hasMedia = true;
          // payload.mediaInfo = data;
          payload.mediaBuffer = await downloadMediaMessage(data, 'buffer', {});
          payload.mediaType = message.imageMessage.mimetype;
          payload.text = message.imageMessage.caption || '';
          payload.info = `<> ${prefix} image message/image with caption`;
        } else if (message.hasOwnProperty('videoMessage')) {
          payload.hasMedia = true;
          // payload.mediaInfo = data;
          payload.mediaBuffer = await downloadMediaMessage(data, 'buffer', {});
          payload.mediaType = message.videoMessage.mimetype;
          payload.text = message.videoMessage.caption || '';
          payload.info = `<> ${prefix} video message`;
        } else if (message.hasOwnProperty('documentMessage')) {
          payload.hasDocument = true;
          payload.hasMedia = true;
          // payload.mediaInfo = data;
          payload.mediaBuffer = await downloadMediaMessage(data, 'buffer', {});
          payload.mediaType = message.documentMessage.mimetype;
          payload.info = `<> ${prefix} PDF without caption (documentMessage)`;
        } else if (message.hasOwnProperty('conversation')) {
          payload.text = message.conversation;
          payload.info = `<> ${prefix} simple text conversation`;
        } else if (
          message.hasOwnProperty('locationMessage') ||
          message.hasOwnProperty('liveLocationMessage')
        ) {
          payload.hasLocation = true;
          payload.location = message.hasOwnProperty('locationMessage')
            ? {
                latitude: message.locationMessage?.degreesLatitude,
                longitude: message.locationMessage?.degreesLongitude,
              }
            : {
                latitude: message.liveLocationMessage?.degreesLatitude,
                longitude: message.liveLocationMessage?.degreesLongitude,
              };
          payload.info = `<> ${prefix} location message`;
        } else {
          payload.info = 'case Not Found';
          payload.meta = data;
        }

        return payload;
      } else {
        payload.shouldNotifyWebhook = false;
        return payload;
      }
    } catch (e) {
      console.log('error cause');
      console.log(data);
      console.log(e);
      payload.shouldNotifyWebhook = false;
      return payload;
    }
  }
  getSession(id: string): WASocket | null {
    return this.sessions.get(id)?.sock || null;
  }

  async listSessions(): Promise<any> {
    const allDbSessions = await this.prisma.whats_app_session.findMany({
      where: { serverId: Number(process.env.SERVER_ID) },
      select: { sessionId: true },
    });
    return { sessions: allDbSessions.map((s) => s.sessionId) };
  }

  async listAllConnectedSessions(): Promise<any> {
    const keys = Array.from(this.sessions.keys());
    const connectedSessions = keys.filter(
      (session) => this.getSessionStatus(session).isActive === true,
    );
    return { sessions: connectedSessions };
  }

  listAllDisconnectedSessions(): { sessions: string[] } {
    const keys = Array.from(this.sessions.keys());
    const disconnectedSessions = keys.filter(
      (session) => this.getSessionStatus(session).isActive === false,
    );
    return { sessions: disconnectedSessions };
  }
  getSessionStatus(id: string): {
    status: string;
    isActive: boolean;
    message?: string;
    phoneNumber?: string;
  } {
    const session = this.sessions.get(id); // Assume 'this.sessions' stores BaileysSession objects

    if (!session) {
      return {
        status: 'DISCONNECTED',
        isActive: false,
        message: 'Session not found',
      };
    }
    this.logger.log('session', session.sock.user);
    // Get the status from the session, default to 'UNKNOWN' if not set
    const status = (session.connectionStatus || 'UNKNOWN').toUpperCase();
    const isActive = status !== 'CLOSE'; // Only OPEN means active

    const phoneNumber = session.sock?.user?.id?.split(':')[0] || 'Unknown';

    // Log based on the real-time status
    this.logger.log(`[${id}] Session status: ${status}, Phone: ${phoneNumber}`);

    if (status === 'CLOSE' && session.lastDisconnectError) {
      return {
        status: 'DISCONNECTED',
        isActive: false,
        message: `Connection closed: ${session.lastDisconnectError.message || 'Unknown error'}`,
        phoneNumber,
      };
    }

    this.logger.log('isActive', { isActive, phoneNumber });
    return {
      status: isActive ? 'CONNECTED' : 'DISCONNECTED',
      isActive: isActive && phoneNumber !== 'Unknown',
      phoneNumber,
    };
  }

  async removeAllInactiveSessions() {
    const inactiveSessions = this.listAllDisconnectedSessions().sessions;
    const promises = inactiveSessions.map((session) =>
      this.removeSessionById(session),
    );
    const removedSessions = await Promise.all(promises);

    return {
      success: true,
      message: `${removedSessions.length} inactive session(s) removed.`,
      sessions: removedSessions,
    };
  }

  async removeSessionById(id: string) {
    const sessionExists = this.sessions.has(id);
    const session = this.sessions.get(id);

    try {
      if (session && session.sock) {
        // Clear health check interval
        const sock = session.sock as any;
        if (sock._healthCheckInterval) {
          clearInterval(sock._healthCheckInterval);
          delete sock._healthCheckInterval;
        }

        // Only try to logout if the socket is still open
        this.logger.log('sock.ws?.readyState', sock.ws?.readyState);
        // if (sock.ws?.readyState === 1) {
        await session.sock.logout();
        // }
      }
    } catch (error: any) {
      this.logger.warn(
        `[${id}] Error during logout: ${error?.message || 'Unknown error'}`,
      );
    } finally {
      // Clean up tracking data
      this.sessions.delete(id);
      this.qrCodes.delete(id);
      this.reconnectionAttempts.delete(id);

      const deletedSession = await this.prisma.whats_app_session
        .delete({
          where: { sessionId: id, serverId: Number(process.env.SERVER_ID) },
        })
        .catch(() => null);
      this.logger.log('deletedSession', deletedSession);

      return {
        success: !!deletedSession,
        message: deletedSession
          ? `Session removed successfully.`
          : `Session not found.`,
      };
    }
  }

  async getQrCodeImage(id: string): Promise<Buffer | null> {
    const qr = this.qrCodes.get(id);
    if (!qr) return null;
    return await qrcode.toBuffer(qr); // returns PNG image buffer
  }

  getQrCode(id: string): any {
    const qr = this.qrCodes.get(id);
    if (!qr)
      return {
        success: true,
        qr: null,
        message: 'QR code not found/ Already Scanned',
      };
    return {
      success: true,
      qr: qr,
      message: qr ? 'QR code found' : 'QR code not found/ already Scanned',
    };
  }

  async mockTyping(id: string, number: string, presence: WAPresence) {
    const sock = this.getSession(id);
    if (!sock) {
      this.logger.warn(`No active session for ${id} when setting presence`);
      return;
    }
    const remoteJid = `${number}@s.whatsapp.net`;
    try {
      await Promise.race([
        sock.sendPresenceUpdate(presence, remoteJid),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Presence update timeout')), 5000),
        ),
      ]);
    } catch (error: any) {
      this.logger.error(
        `Error updating presence for ${number}:`,
        error?.message || 'Unknown error',
      );
    }
  }

  async clearMockTyping(id: string, number: string) {
    const sock = this.getSession(id);
    if (!sock) {
      this.logger.warn(`No active session for ${id} when clearing presence`);
      return;
    }
    const remoteJid = `${number}@s.whatsapp.net`;
    try {
      await Promise.race([
        sock.sendPresenceUpdate('paused', remoteJid),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Presence clear timeout')), 5000),
        ),
      ]);
    } catch (error: any) {
      this.logger.error(
        `Error clearing presence for ${number}:`,
        error?.message || 'Unknown error',
      );
    }
  }
  async checkNumberOnWhatsApp(id: string, number: string): Promise<boolean> {
    const sock = this.getSession(id);
    if (!sock) {
      this.logger.warn(
        `No active session for ${id} when checking number ${number}`,
      );
      return false;
    }
    try {
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Number check timeout')), 10000);
      });

      const checkPromise = sock.onWhatsApp(`${number}@s.whatsapp.net`);
      const result = await Promise.race([checkPromise, timeoutPromise]);
      return Boolean(result?.[0]?.exists);
    } catch (error: any) {
      this.logger.error(
        `Error checking number ${number}:`,
        error?.message || 'Unknown error',
      );
      return false;
    }
  }
  async getProfileUrl(id: string, number: string): Promise<any> {
    const sock = this.getSession(id);
    if (!sock) {
      this.logger.warn(`No active session for ${id} when getting profile URL`);
      return '';
    }
    try {
      const jid = `${number}@s.whatsapp.net`;
      // Add timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Profile picture timeout')), 10000);
      });

      const ppPromise = sock.profilePictureUrl(jid, 'image');
      const ppUrl = await Promise.race([ppPromise, timeoutPromise]);
      return ppUrl;
    } catch (error: any) {
      this.logger.error(
        `Error getting profile picture for ${number}:`,
        error?.message || 'Unknown error',
      );
      return '';
    }
  }

  private async notifyApiOfStatusChange(
    id: string,
    connection: string,
    sock: any,
    lastDisconnect?: any,
  ): Promise<void> {
    const webhookUrl = `${process.env.WEBHOOK_URL}/status`;
    let status: boolean = false;
    let message: string;

    if (connection === 'open') {
      status = true;
      message = `Session connected successfully.`;
    } else {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message ?? 'Unknown reason';
      if (statusCode === DisconnectReason.loggedOut) {
        message = 'Session was logged out from the phone';
      } else {
        message = `Connection lost. Reason: ${errorMessage} (Code: ${statusCode ?? 'N/A'}).`;
      }
    }
    const payload = {
      sessionId: id,
      status,
      message: message,
    };

    try {
      await axios.post(webhookUrl, payload, { timeout: 15000 });
      this.logger.log('status-api', {
        context: 'notify-connection-status',
        message: 'API notification sent successfully.',
        parameters: payload,
      });
    } catch (error: any) {
      this.logger.error('status-api', {
        context: 'notify-connection-status',
        error: error.message,
        parameters: payload,
      });
    }
  }
}
