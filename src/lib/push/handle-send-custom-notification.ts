import Expo, { type ExpoPushMessage } from "expo-server-sdk";

import { getSupabaseAdminClient } from "@/lib/supabase/server";

const expo = new Expo();

export type SendCustomNotificationInput = {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  /** Si se omite o va vacío, se usan todos los tokens en `push_tokens`. */
  tokens?: string[];
  /**
   * Si se provee, iOS (apns-collapse-id) y Android (collapse_key via FCM)
   * reemplazan la notificación previa con el mismo collapseId en lugar de
   * apillar una nueva. Ideal para "actualizar" en vez de duplicar.
   */
  collapseId?: string;
};

export type SendCustomNotificationResult = {
  ok: true;
  sent: number;
  tickets: unknown[];
  /** Presente cuando no hay tokens que enviar. */
  message?: string;
};

/**
 * Envía una notificación push vía Expo a tokens concretos o a todos los registrados en Supabase.
 */
export async function handleSendCustomNotification(
  input: SendCustomNotificationInput,
): Promise<SendCustomNotificationResult> {
  const title = input.title ?? "Personal Tracker";
  const messageBody = input.body ?? "";

  const supabase = getSupabaseAdminClient();

  let tokens: string[];
  if (input.tokens && input.tokens.length > 0) {
    tokens = input.tokens;
  } else {
    const { data, error } = await supabase.from("push_tokens").select("token");
    if (error) throw new Error(error.message);
    tokens = (data ?? []).map((r: { token: string }) => r.token);
  }

  if (tokens.length === 0) {
    return { ok: true, sent: 0, tickets: [], message: "no tokens registered" };
  }

  const validTokens = tokens.filter((t) => Expo.isExpoPushToken(t));
  if (validTokens.length === 0) {
    throw new Error("no valid Expo push tokens");
  }

  const messages: ExpoPushMessage[] = validTokens.map((to) => ({
    to,
    title,
    body: messageBody,
    data: input.data ?? {},
    sound: "default",
    ...(input.collapseId ? { collapseId: input.collapseId } : {}),
  }));

  console.log("[push] send", {
    title,
    collapseId: input.collapseId,
    devices: validTokens.length,
    data: input.data,
  });

  const chunks = expo.chunkPushNotifications(messages);
  const tickets: unknown[] = [];

  for (const chunk of chunks) {
    const chunkTickets = await expo.sendPushNotificationsAsync(chunk);
    tickets.push(...chunkTickets);
  }

  return { ok: true, sent: validTokens.length, tickets };
}
