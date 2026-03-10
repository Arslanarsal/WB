import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Res,
} from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import {
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Response } from 'express';

export enum WAPresence {
  UNAVAILABLE = 'unavailable',
  AVAILABLE = 'available',
  COMPOSING = 'composing',
  RECORDING = 'recording',
  PAUSED = 'paused',
}

export enum MessageType {
  TEXT = 'text',
  MEDIA = 'media',
}
class ConnectDto {
  @ApiProperty()
  id: string;

  @ApiPropertyOptional({
    description: 'Use pairing code instead of QR code',
    default: false,
  })
  usePairingCode?: boolean;

  @ApiPropertyOptional({
    description: 'Phone number (required when using pairing code)',
    example: '1234567890',
  })
  phoneNumber?: string;
}

class SendTextDto {
  @ApiProperty()
  number: string;
  @ApiProperty()
  text: string;
}
class isOnWhatsAppDto {
  @ApiProperty({
    example: '923557609998',
  })
  number: string;
}

class SendMessageDto {
  @ApiProperty({
    example: '923557609998',
  })
  number: string;

  @ApiProperty()
  url?: string;

  @ApiPropertyOptional()
  text?: string;

  @ApiProperty({
    enum: MessageType,
    example: MessageType.TEXT,
  })
  type: MessageType;

  @ApiPropertyOptional()
  isVoiceMode?: boolean;

  @ApiPropertyOptional()
  mentions?: string[];
}
class MockTypingDto {
  @ApiProperty({
    example: '923557609998',
  })
  number: string;

  @ApiProperty({
    example: '7',
  })
  session: string;

  @ApiProperty({
    enum: WAPresence,
    example: WAPresence.COMPOSING,
    default: WAPresence.COMPOSING,
  })
  presence?: WAPresence;
}

@ApiTags('WhatsApp')
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}
  @Post('chat/clear-mock-typing')
  async clearMockTyping(@Body() dto: MockTypingDto) {
    await this.whatsappService.clearMockTyping(dto.session, dto.number);
    return { success: true };
  }

  @Post('chat/mock-typing')
  async mockTyping(@Body() dto: MockTypingDto) {
    await this.whatsappService.mockTyping(
      dto.session,
      dto.number,
      dto.presence ?? WAPresence.COMPOSING,
    );
    return { success: true };
  }

  @Post('connect')
  @ApiOperation({ summary: 'Connect a WhatsApp session' })
  @ApiBody({ type: ConnectDto })
  async connect(@Body() body: ConnectDto) {
    try {

      const result = await this.whatsappService.connect(
        body.id,
      );
      return {
        success: true,
        sessionId: result.id,
        message: 'Session Initialized successfully',
      };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }
  @Post(':id/get-profile-pic-url')
  @ApiOperation({ summary: 'get profile url ' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiBody({ type: isOnWhatsAppDto })
  async getProfileUrl(@Param('id') id: string, @Body() body: isOnWhatsAppDto) {
    try {
      const profileUrl = await this.whatsappService.getProfilePic(
        id,
        body.number,
      );
      return { success: true, result: profileUrl };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  @Post(':id/is-on-whatsapp')
  @ApiOperation({ summary: 'check number is on whatsapp or not ' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiBody({ type: isOnWhatsAppDto })
  async isOnWhatsApp(@Param('id') id: string, @Body() body: isOnWhatsAppDto) {
    try {
      return await this.whatsappService.isOnWhatsApp(id, body.number);
    } catch (e) {
      return { success: false, message: e.message };
    }
  }
  @Post(':id/send-message')
  @ApiOperation({ summary: 'Send message ' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  @ApiBody({ type: SendMessageDto })
  async sendMessage(@Param('id') id: string, @Body() body: SendMessageDto) {
    try {
      if (body.type === MessageType.TEXT && body.text) {
        const res = await this.whatsappService.sendText(
          id,
          body.number,
          body.text,
          body.mentions ?? [],
        );
        return { success: res.wb_id ? true : false, result: res };
      } else if (body.type === MessageType.MEDIA && body.url) {
        const res = await this.whatsappService.sendMedia(
          id,
          body?.url,
          body.number,
          body?.isVoiceMode ? true : false,
          body.text,
          body.mentions ?? [],
        );

        return { success: res.wb_id ? true : false, result: res };
      } else {
        return {
          success: false,
          result: { wb_id: null, text: null, at: null },
        };
      }
    } catch (e) {
      return { success: false, result: { wb_id: null, text: null, at: null } };
    }
  }

  @Get('sessions')
  @ApiOperation({ summary: 'List all sessions' })
  async listSessions() {
    return await this.whatsappService.listSessions();
  }

  @Get('sessions/connected')
  @ApiOperation({ summary: 'List all connected sessions' })
  async listConnectedSessions() {
    return await this.whatsappService.listConnectedSessions();
  }

  @Get('sessions/disconnected')
  @ApiOperation({ summary: 'List all disconnected sessions' })
  listDisconnectedSessions() {
    return this.whatsappService.listAllDisconnectedSessions();
  }

  @Get('sessions/:id/status')
  @ApiOperation({ summary: 'Get the status of a specific session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  async getSessionStatus(@Param('id') id: string) {
    const status = this.whatsappService.getSessionStatus(id);
    return { success: true, status };
  }

  @Get('sessions/:id/remove')
  @ApiOperation({ summary: 'Remove a specific session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  async removeSessionById(@Param('id') id: string) {
    const result = await this.whatsappService.removeSessionById(id);
    return { success: result.success, message: result.message };
  }

  @Get('sessions/remove-all-inactive')
  @ApiOperation({ summary: '🗑️ Remove all inactive sessions' })
  async removeAllInactiveSessions() {
    const result = await this.whatsappService.removeAllInactiveSessions();
    return {
      success: result.success,
      message: result.message,
      sessions: result.sessions,
    };
  }

  @Get('sessions/qrcode/:id')
  @ApiOperation({ summary: '🔍 Get the QR code for a specific session' })
  @ApiParam({ name: 'id', description: 'Session ID' })
  async getQRCode(@Param('id') id: string) {
    return this.whatsappService.getQrCode(id);
  }


  @Get('getQrCodeImage/:id')
  async getQrCodeImage(@Param('id') id: string, @Res() res: Response) {
    const imageBuffer = await this.whatsappService.getQrCodeImage(id);
    res.setHeader('Content-Type', 'image/png');
    res.send(imageBuffer);
  }
}
