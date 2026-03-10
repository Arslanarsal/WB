import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SendMessageDto {
  @ApiProperty({
    description:
      'The phone number to send the message to, including country code',
    example: '+1234567890',
  })
  number: string;

  @ApiPropertyOptional({
    description: 'Optional caption for the image',
    example: 'Check out this image!',
  })
  caption?: string;

  @ApiPropertyOptional({
    description: 'Optional caption for the image',
    example: 'Check out this image!',
  })
  text?: string;

  @ApiPropertyOptional({
    description: 'URL of the image to be sent',
    example: 'https://example.com/image.jpg',
  })
  imageUrl?: string;
}

export enum PhoneType {
  JID = '@s.whatsapp.net',
}
