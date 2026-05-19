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
import { Injectable, Logger } from '@nestjs/common';
import { createPrismaAuthState } from './helpers/prisma-auth-state';
import { StorageService } from './storage-service';
import { PrismaService } from '../prisma/prisma.service';

type Session = {
  id: string;
  sock: WASocket;
  pairingCode?: string;
  connectionStatus?: string;
  lastDisconnectError?: any;
};

@Injectable()
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private qrCodes = new Map<string, string>();
  private pairingCodes = new Map<string, string>();
  private reconnectionAttempts = new Map<string, number>();
  private messageStores = new Map<string, Map<string, any>>();
  private readonly maxReconnectionAttempts = 5;
  private readonly MESSAGE_STORE_LIMIT = 5000;
  private readonly logger = new Logger(SessionManager.name);

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
  ) {}

  async createSession(
    id: string,
    usePairingCode?: boolean,
    phoneNumber?: string,
  ): Promise<Session> {
    try {
      this.logger.log(`[${id}] Creating WhatsApp session${usePairingCode ? ' with pairing code' : ''}...`);
      const { state, saveCreds } = await createPrismaAuthState(id, this.prisma);
      const { version, isLatest } = await fetchLatestWaWebVersion({});

      // Initialize message store for retry support
      if (!this.messageStores.has(id)) {
        this.messageStores.set(id, new Map());
      }
      const msgStore = this.messageStores.get(id)!;

      const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 1000,
        maxMsgRetryCount: 5,
        qrTimeout: 60000,
        markOnlineOnConnect: true,
        emitOwnEvents: true,
        generateHighQualityLinkPreview: false,
        patchMessageBeforeSending: (message: any) => {
          const requiresPatch = !!(
            message.buttonsMessage ||
            message.templateMessage ||
            message.listMessage
          );
          if (requiresPatch) {
            message = {
              viewOnceMessage: {
                message: {
                  messageContextInfo: {
                    deviceListMetadataVersion: 2,
                    deviceListMetadata: {},
                  },
                  ...message,
                },
              },
            };
          }
          return message;
        },
        getMessage: async (key) => {
          if (!key.id) return undefined;
          const cached = msgStore.get(key.id);
          if (cached?.message) return cached.message;

          try {
            const row = await this.prisma.wb_messages_cache.findUnique({
              where: {
                sessionId_messageId: { sessionId: id, messageId: key.id },
              },
            });
            if (row?.message) {
              return row.message as any;
            }
          } catch (err: any) {
            this.logger.warn(
              `[${id}] getMessage DB fallback failed: ${err?.message || 'Unknown error'}`,
            );
          }
          return undefined;
        },
      });

      // Request pairing code from WhatsApp if requested
      if (usePairingCode && phoneNumber) {
        try {
          const cleanPhoneNumber = phoneNumber.replace(/\D/g, '');
          await new Promise(resolve => setTimeout(resolve, 2000));
          this.logger.log(`[${id}] Requesting pairing code for phone number: ${cleanPhoneNumber}`);
          const pairingCode = await sock.requestPairingCode(cleanPhoneNumber);
          this.pairingCodes.set(id, pairingCode);
          this.logger.log(`[${id}] Pairing code received: ${pairingCode}`);
        } catch (error: any) {
          this.logger.error(`[${id}] Error requesting pairing code:`, error?.message || 'Unknown error');
          const fallbackCode = Math.floor(10000000 + Math.random() * 90000000).toString();
          this.pairingCodes.set(id, fallbackCode);
          this.logger.log(`[${id}] Generated fallback pairing code: ${fallbackCode}`);
        }
      }

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

      this.wrapSocketWithErrorHandling(id, sock);

      sock.ev.on('messages.upsert', async (m) => {
        try {
          const keysToAck: any[] = [];
          const toCache: { messageId: string; message: any }[] = [];
          if (m.messages) {
            for (const msg of m.messages) {
              if (msg.key?.id && msg.message) {
                msgStore.set(msg.key.id, msg);
                if (msgStore.size > this.MESSAGE_STORE_LIMIT) {
                  const firstKey = msgStore.keys().next().value;
                  if (firstKey) msgStore.delete(firstKey);
                }
                toCache.push({ messageId: msg.key.id, message: msg.message });
              }
              if (msg.key && !msg.key.fromMe && msg.message) {
                keysToAck.push(msg.key);
              }
            }
          }

          if (keysToAck.length > 0) {
            sock.readMessages(keysToAck).catch((err: any) => {
              this.logger.warn(
                `[${id}] readMessages failed: ${err?.message || 'Unknown error'}`,
              );
            });
          }

          if (toCache.length > 0) {
            Promise.all(
              toCache.map(({ messageId, message }) =>
                this.prisma.wb_messages_cache
                  .upsert({
                    where: {
                      sessionId_messageId: { sessionId: id, messageId },
                    },
                    create: { sessionId: id, messageId, message: message as any },
                    update: { message: message as any },
                  })
                  .catch(() => undefined),
              ),
            ).catch(() => undefined);
          }

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
        });
      }
      const session: Session = {
        id,
        sock,
        pairingCode: usePairingCode ? this.pairingCodes.get(id) : undefined,
      };
      this.sessions.set(id, session);

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

      // End the socket to cancel pending internal operations (retry requests, etc.)
      // This prevents unhandled promise rejections from stale send attempts
      try {
        if ((sock as any)._presenceHeartbeat) {
          clearInterval((sock as any)._presenceHeartbeat);
          delete (sock as any)._presenceHeartbeat;
        }
        sock.end(undefined);
      } catch (_) {}

      if (isLoggedOut) {
        this.logger.log(
          `[${id}] ❌ Session logged out from mobile. Removing session.`,
        );
        this.removeSessionById(id);
        return;
      }

      const isConflict =
        statusCode === 440 || errorMessage?.toLowerCase()?.includes('conflict');

      if (isConflict) {
        this.logger.log(
          `[${id}] ❌ Session conflict detected (Code: 440). Session keys are corrupted or another client connected. Removing session — a fresh QR scan is required.`,
        );
        this.removeSessionById(id);
        return;
      }

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
      this.reconnectionAttempts.delete(id);

      sock.sendPresenceUpdate('available').catch((err: any) => {
        this.logger.warn(
          `[${id}] Initial presence update failed: ${err?.message || 'Unknown error'}`,
        );
      });

      if (sock._presenceHeartbeat) {
        clearInterval(sock._presenceHeartbeat);
      }
      sock._presenceHeartbeat = setInterval(() => {
        sock.sendPresenceUpdate('available').catch((err: any) => {
          this.logger.warn(
            `[${id}] Presence heartbeat failed: ${err?.message || 'Unknown error'}`,
          );
        });
      }, 25000);
    }
  }

  private wrapSocketWithErrorHandling(id: string, sock: any) {
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
          message?.key?.remoteJid?.endsWith('@broadcast')
        )
          continue;

        const remoteJid = message?.key?.remoteJid;
        if (remoteJid) {
          const remoteid = remoteJid.split('@')[0];
          if (remoteJid.endsWith('@lid')) {
            // LID message - extract LID, check senderPn for phone
            const senderPn = message?.key?.senderPn;
            const phoneFromSenderPn = senderPn ? senderPn.split('@')[0] : null;

            message.key['userlid'] = remoteid;

            if (phoneFromSenderPn) {
              // We have the phone number from senderPn → isFromLid = false
              message.key['isFromLid'] = false;
              message.key['userPhone'] = phoneFromSenderPn;
            } else {
              // No phone available → true LID-only contact
              message.key['isFromLid'] = true;
              message.key['userPhone'] = remoteid;
            }
          } else {
            // Regular phone message - try to get LID
            message.key['isFromLid'] = false;
            message.key['userPhone'] = remoteid;
            try {
              const lidData = await this.checkNumberOnWhatsAppV2(id, remoteid);
              message.key['userlid'] = lidData?.[0]?.lid?.split('@')[0] ?? null;
            } catch (lidErr: any) {
              this.logger.warn(`[${id}] Could not get LID for ${remoteid}:`, lidErr?.message);
              message.key['userlid'] = null;
            }
          }
          message.key['companyPhone'] = sock.user?.id.split(':')[0];
        }
        if (message.key['userPhone'] === message.key['companyPhone']) {
          continue;
        }

        const payload = await this.messageHandler(message);
       
        if (payload.shouldNotifyWebhook) {
          await this.sendWebhookWithRetry(payload);
        }
      } catch (messageError: any) {
        this.logger.error(
          `[${id}] Error processing message ${message?.key?.id}:`,
          messageError?.message || 'Unknown error',
        );
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
        const response = await axios.post(
          `${webhookUrl}/message-update`,
          payload,
          {
            timeout: 50000,
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': 'WhatsApp-Bot/1.0',
            },
            // Prevent axios from throwing on HTTP error status codes
            validateStatus: (status) => status < 500,
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

    if (payload.hasMedia) {
      try {
        const mediaObject = {
          hasMedia: true,
          mimeType: payload.mediaType,
          buffer: payload.mediaBuffer,
        };

        const company = payload.companyPhone || 'default';
        const contact = payload.userPhone || 'unknown';

        const mediaUrl = await this.storageService.uploadMedia(
          mediaObject,
          company,
          contact,
        );

        if (mediaUrl) {
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
      delete payload.mediaBuffer;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(webhookUrl, payload, {
          timeout: 50000,
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

        const backoffDelay =
          delay * Math.pow(2, attempt - 1) + Math.random() * 1000;
        console.log(`Retrying webhook in ${Math.round(backoffDelay)}ms...`);
        await this.sleep(backoffDelay);
      }
    }
  }

  private isRetryableError(error: any): boolean {
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
      isFromLid: data.key.isFromLid ?? false,
      userlid: data.key.userlid ?? null,
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
        if (message.hasOwnProperty('extendedTextMessage')) {
          payload.text = message?.extendedTextMessage?.text;
          payload.info = `<> ${prefix} reply message`;
        } else if (message.hasOwnProperty('audioMessage')) {
          payload.isAudio = true;

          payload.hasMedia = true;
          payload.mediaBuffer = await downloadMediaMessage(data, 'buffer', {});
          payload.mediaType = message.audioMessage.mimetype;
          payload.info = `<> ${prefix} audio/audio reply message`;
        } else if (message.hasOwnProperty('documentWithCaptionMessage')) {
          payload.hasDocument = true;
          payload.hasMedia = true;

          payload.mediaBuffer = await downloadMediaMessage(data, 'buffer', {});
          payload.mediaType = message.documentWithCaptionMessage.mimetype;
          payload.text = message.documentWithCaptionMessage.message.documentMessage.caption;
          payload.info = `<> ${prefix} PDF with caption message`;
        } else if (message.hasOwnProperty('imageMessage')) {
          payload.hasMedia = true;

          payload.mediaBuffer = await downloadMediaMessage(data, 'buffer', {});
          payload.mediaType = message.imageMessage.mimetype;
          payload.text = message.imageMessage.caption || '';
          payload.info = `<> ${prefix} image message/image with caption`;
        } else if (message.hasOwnProperty('videoMessage')) {
          payload.hasMedia = true;

          payload.mediaBuffer = await downloadMediaMessage(data, 'buffer', {});
          payload.mediaType = message.videoMessage.mimetype;
          payload.text = message.videoMessage.caption || '';
          payload.info = `<> ${prefix} video message`;
        } else if (message.hasOwnProperty('documentMessage')) {
          payload.hasDocument = true;
          payload.hasMedia = true;

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
      this.logger.error('messageHandler error', { data, error: e });
      payload.shouldNotifyWebhook = false;
      return payload;
    }
  }
  getSession(id: string): WASocket | null {
    return this.sessions.get(id)?.sock || null;
  }

  async listSessions(): Promise<any> {
    const allDbSessions = await this.prisma.whats_app_session.findMany({
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
    const session = this.sessions.get(id);

    if (!session) {
      return {
        status: 'DISCONNECTED',
        isActive: false,
        message: 'Session not found',
      };
    }
    this.logger.log('session', session.sock.user);
    const status = (session.connectionStatus || 'UNKNOWN').toUpperCase();
    const isActive = status !== 'CLOSE';

    const phoneNumber = session.sock?.user?.id?.split(':')[0] || 'Unknown';

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
        const sock = session.sock as any;
        if (sock._healthCheckInterval) {
          clearInterval(sock._healthCheckInterval);
          delete sock._healthCheckInterval;
        }
        if (sock._presenceHeartbeat) {
          clearInterval(sock._presenceHeartbeat);
          delete sock._presenceHeartbeat;
        }

        this.logger.log('sock.ws?.readyState', sock.ws?.readyState);
        await session.sock.logout();
      }
    } catch (error: any) {
      this.logger.warn(
        `[${id}] Error during logout: ${error?.message || 'Unknown error'}`,
      );
    } finally {
      this.sessions.delete(id);
      this.qrCodes.delete(id);
      this.pairingCodes.delete(id);
      this.reconnectionAttempts.delete(id);
      this.messageStores.delete(id);

      const deletedSession = await this.prisma.whats_app_session
        .delete({
          where: { sessionId: id },
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

  getPairingCode(id: string): any {
    const pairingCode = this.pairingCodes.get(id);
    if (!pairingCode) return { success: true, pairingCode: null, message: 'Pairing code not found/ Already used' };
    return { success: true, pairingCode: pairingCode, message: pairingCode ? 'Pairing code found' : 'Pairing code not found/ already used' };
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
  async checkNumberOnWhatsAppV2(id: string, number: string): Promise<any[]> {
    const sock = this.getSession(id);
    if (!sock) {
      this.logger.warn(
        `No active session for ${id} when checking number with lid ${number}`,
      );
      return [];
    }
    try {
      const timeoutPromise = new Promise<any[]>((_, reject) => {
        setTimeout(() => reject(new Error('Number check v2 timeout')), 10000);
      });
      const checkPromise = sock.onWhatsApp(`${number}@s.whatsapp.net`);
      const result = await Promise.race([checkPromise, timeoutPromise]);
      return result || [];
    } catch (error: any) {
      this.logger.error(
        `Error checking number with lid ${number}:`,
        error?.message || 'Unknown error',
      );
      return [];
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
