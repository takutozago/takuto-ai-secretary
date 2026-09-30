import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";

const COOKIE_NAME = "__Host-google-oauth-state";
const REQUIRED_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.readonly";

function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function page(content: string, status = 200) {
  return new Response(
    `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Googleカレンダー連携</title></head>
<body><main><h1>Googleカレンダー連携</h1>${content}</main></body>
</html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "Set-Cookie":
          `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      },
    }
  );
}

export async function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const signingSecret = process.env.LINE_CHANNEL_SECRET;

  if (!clientId || !clientSecret || !redirectUri || !signingSecret) {
    return page("<p>接続設定が不足しています。</p>", 500);
  }

  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);

  const parts = state.split(".");
  const expires = Number(parts[0]);
  const nonce = parts[1] ?? "";
  const signature = parts[2] ?? "";
  const now = Math.floor(Date.now() / 1000);
  const expected = createHmac("sha256", signingSecret)
    .update(`google-oauth-state:${parts[0]}.${nonce}`)
    .digest("hex");

  if (
    !cookie ||
    !equal(state, cookie) ||
    parts.length !== 3 ||
    !Number.isSafeInteger(expires) ||
    expires <= now ||
    expires > now + 600 ||
    !/^[a-f0-9]{64}$/.test(nonce) ||
    !equal(signature, expected)
  ) {
    return page(
      "<p>接続の確認に失敗しました。LINEから連携をやり直してください。</p>",
      400
    );
  }

  if (url.searchParams.has("error")) {
    return page("<p>Googleとの連携をキャンセルしました。</p>", 400);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return page("<p>Googleの認証コードがありません。</p>", 400);
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });

    if (!response.ok) {
      return page(
        "<p>Googleとの接続に失敗しました。LINEから連携をやり直してください。</p>",
        502
      );
    }

    const data = (await response.json()) as {
      refresh_token?: string;
      scope?: string;
    };

    if (!data.scope?.split(" ").includes(REQUIRED_SCOPE)) {
      return page("<p>予定を読む権限が許可されていません。</p>", 403);
    }

    if (!data.refresh_token) {
      return page(
        "<p>継続接続用の情報を取得できませんでした。LINEから連携をやり直してください。</p>",
        400
      );
    }

    return page(
      `<p>Googleの許可を確認しました。設定はあと一歩です。</p>
<p>下の値をコピーして、Vercelの環境変数
<strong>GOOGLE_REFRESH_TOKEN</strong> に、Secret・Productionで保存してください。</p>
<p>この値はチャットやGitHubには貼らないでください。</p>
<textarea readonly rows="6" cols="50" aria-label="継続接続用の値">${escapeHtml(data.refresh_token)}</textarea>
<p>保存後、この画面を閉じてください。LINEから予定を確認する処理は別途必要です。</p>`
    );
  } catch {
    return page(
      "<p>接続処理を完了できませんでした。LINEから連携をやり直してください。</p>",
      502
    );
  }
}
