import { PrismaClient } from '@prisma/client';

export const createPrismaAuthState = async (
  sessionId: string,
  prisma: PrismaClient,
) => {
  // Baileys v7 is ESM-only; load it via dynamic import so this CJS project can consume it.
  const baileys: any = await (Function(
    'return import("@whiskeysockets/baileys")',
  )() as Promise<any>);
  const { initAuthCreds, BufferJSON } = baileys;
  let writeTimeout: NodeJS.Timeout | undefined = undefined;

  const initialData = await prisma.whats_app_session.findUnique({
    where: {
      sessionId,
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
      writeTimeout = undefined;
      try {
        const jsonData = {
          creds: JSON.parse(JSON.stringify(creds, BufferJSON.replacer)),
          keys: JSON.parse(JSON.stringify(keys, BufferJSON.replacer)),
        };

        await prisma.whats_app_session.upsert({
          where: { sessionId },
          create: {
            sessionId,
            ...jsonData,
          },
          update: {
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
    }, 50);
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
              if (value) {
                keys[dbKey] = value;
              } else {
                // Baileys passes null/undefined to signal key deletion —
                // keeping stale keys corrupts the Signal session and causes
                // "Waiting for this message" on the recipient side.
                delete keys[dbKey];
              }
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
