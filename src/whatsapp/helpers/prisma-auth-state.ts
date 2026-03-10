import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

export const createPrismaAuthState = async (
  sessionId: string,
  prisma: PrismaClient,
) => {
  const logger = new Logger(createPrismaAuthState.name);
  let writeTimeout: NodeJS.Timeout | undefined = undefined;

  const initialData = await prisma.whats_app_session.findUnique({
    where: {
      sessionId,
      serverId: Number(process.env.SERVER_ID),
    },
  });

  const creds = initialData?.creds
    ? JSON.parse(JSON.stringify(initialData.creds), BufferJSON.reviver)
    : initAuthCreds();

  const keys = initialData?.keys
    ? JSON.parse(JSON.stringify(initialData.keys), BufferJSON.reviver)
    : {};

  const debouncedSaveState = () => {
    if (writeTimeout) {
      clearTimeout(writeTimeout);
    }
    writeTimeout = setTimeout(async () => {
      try {
        const jsonData = {
          creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
          keys: JSON.parse(JSON.stringify(keys, BufferJSON.replacer)),
        };

        await prisma.whats_app_session.upsert({
          where: { sessionId },
          create: {
            sessionId,
            serverId: Number(process.env.SERVER_ID),
            ...jsonData,
          },
          update: {
            serverId: Number(process.env.SERVER_ID),
            ...jsonData,
          },
        });
        console.log(`[${sessionId}] ✅ Session saved successfully.`);
      } catch (err) {
        console.error(
          `[${sessionId}] ❌ Failed to save session to database.`,
          err,
        );
      }
    }, 200);
  };

  return {
    state: {
      creds: creds,
      keys: {
        get: (type, ids) => {
          const data: { [key: string]: any } = {};
          for (const id of ids) {
            const key = `${type}-${id}`;
            if (keys[key]) {
              data[id] = keys[key];
            }
          }
          return data;
        },
        set: (data) => {
          for (const keyType in data) {
            for (const id in data[keyType]) {
              const value = data[keyType][id];
              const dbKey = `${keyType}-${id}`;
              keys[dbKey] = value;
            }
          }
          debouncedSaveState();
        },
      },
    },
    saveCreds: () => {
      debouncedSaveState();
    },
  };
};
