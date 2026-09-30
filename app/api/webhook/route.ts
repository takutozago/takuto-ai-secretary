import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

export async function GET() {
  return Response.json({ status: "ok" });
}

export async function POST(request: Request) {
  const secret = process.env.LINE_CHANNEL_SECRET;

  if (!secret) {
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

  return Response.json({ ok: true });
}
