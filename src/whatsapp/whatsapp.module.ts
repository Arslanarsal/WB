import { Module } from '@nestjs/common';
import { WhatsappService } from './whatsapp.service';
import { WhatsappController } from './whatsapp.controller';
import { StorageService } from './storage-service';
import { SessionManager } from './session-manager';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [WhatsappController],
  providers: [WhatsappService, StorageService, SessionManager],
  exports: [WhatsappService, StorageService, SessionManager],
})
export class WhatsappModule {}
