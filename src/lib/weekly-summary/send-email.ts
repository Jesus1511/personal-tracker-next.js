import nodemailer from "nodemailer";

export async function sendWeeklySummaryEmail(html: string, weekLabel: string): Promise<void> {
  const from = process.env.WEEKLY_EMAIL_FROM;
  const to = process.env.WEEKLY_EMAIL_TO;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  if (!from || !to) throw new Error("WEEKLY_EMAIL_FROM / WEEKLY_EMAIL_TO not set");
  if (!user || !pass) throw new Error("EMAIL_USER and EMAIL_PASS not set (SMTP / Hostinger)");

  const port = Number(process.env.SMTP_PORT) || 465;
  const secure = port === 465;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.hostinger.com",
    port,
    secure,
    requireTLS: !secure,
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    from,
    to,
    subject: `Resumen semanal ${weekLabel}`,
    html,
  });

  if (info.rejected.length) {
    throw new Error(`SMTP rejected: ${info.rejected.join(", ")}`);
  }
}
