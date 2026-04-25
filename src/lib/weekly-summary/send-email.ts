import { Resend } from "resend";

export async function sendWeeklySummaryEmail(html: string, weekLabel: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not set");

  const from = process.env.WEEKLY_EMAIL_FROM;
  const to = process.env.WEEKLY_EMAIL_TO;
  if (!from || !to) throw new Error("WEEKLY_EMAIL_FROM / WEEKLY_EMAIL_TO not set");

  const resend = new Resend(apiKey);

  const { error } = await resend.emails.send({
    from,
    to: [to],
    subject: `Resumen semanal ${weekLabel}`,
    html,
  });

  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
}
