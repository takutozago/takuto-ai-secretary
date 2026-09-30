import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

type LineEvent = {
  type: string;
  mode?: string;
  replyToken?: string;
  message?: {
    type: string;
    text?: string;
  };
};

export async function GET() {
  return Response.json({ status: "ok" });
}

export async function POST(request: Request) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!secret || !accessToken) {
    return new Response("Server configuration missing", {
      status: 500,
    });
  }

  const body = await request.text();
  const signature = request.headers.get("x-line-signature");

  if (!signature) {
    return new Response("Missing signature", { status: 401 });
  }

  const expected = createHmac("sha256", secret)
    .update(body)
    .digest("base64");

  const received = Buffer.from(signature);
  const calculated = Buffer.from(expected);

  if (
    received.length !== calculated.length ||
    !timingSafeEqual(received, calculated)
  ) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: { events?: LineEvent[] } | null;

  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!payload || !Array.isArray(payload.events)) {
    return new Response("Invalid events", { status: 400 });
  }

  try {
    await Promise.all(
      payload.events.map(async (event) => {
        if (
          !event ||
          event.mode === "standby" ||
          event.type !== "message" ||
          event.message?.type !== "text" ||
          typeof event.message.text !== "string" ||
          !event.message.text ||
          !event.replyToken
        ) {
          return;
        }

        const response = await fetch(
          "https://api.line.me/v2/bot/message/reply",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              replyToken: event.replyToken,
              messages: [
                {
                  type: "text",
                  text: event.message.text,
                },
              ],
            }),
            signal: AbortSignal.timeout(10000),
          }
        );

        if (!response.ok) {
          console.error("LINE reply failed:", response.status);
          throw new Error("LINE reply failed");
        }
      })
    );
  } catch {
    return new Response("Reply failed", { status: 502 });
  }

  return Response.json({ ok: true });
}
