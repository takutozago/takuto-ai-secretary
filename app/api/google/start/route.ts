import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const runtime = "nodejs";

const COOKIE_NAME = "__Host-google-oauth-state";

function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function error(message: string, status: number) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export async function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const signingSecret = process.env.LINE_CHANNEL_SECRET;
  const allowedUserId = process.env.LINE_ALLOWED_USER_ID;

  if (!clientId || !redirectUri || !signingSecret || !allowedUserId) {
    return error("連携の設定が不足しています。", 500);
  }

  const url = new URL(request.url);
  const expiresText = url.searchParams.get("expires") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  const expires = Number(expiresText);
  const now = Math.floor(Date.now() / 1000);

  const expected = createHmac("sha256", signingSecret)
    .update(`google-connect:${allowedUserId}:${expiresText}`)
    .digest("hex");

  if (
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + 600 ||
    !equal(signature, expected)
  ) {
    return error(
      "このリンクは無効か、有効期限が切れています。LINEで「カレンダー連携」と送って、新しいリンクを開いてください。",
      403
    );
  }

  const stateExpires = now + 600;
  const nonce = randomBytes(32).toString("hex");
  const payload = `${stateExpires}.${nonce}`;
  const stateSignature = createHmac("sha256", signingSecret)
    .update(`google-oauth-state:${payload}`)
    .digest("hex");
  const state = `${payload}.${stateSignature}`;

  const googleUrl = new URL(
    "https://accounts.google.com/o/oauth2/v2/auth"
  );

  googleUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events.readonly",
    access_type: "offline",
    prompt: "consent select_account",
    state,
  }).toString();

  return new Response(null, {
    status: 302,
    headers: {
      Location: googleUrl.toString(),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie":
        `${COOKIE_NAME}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}
