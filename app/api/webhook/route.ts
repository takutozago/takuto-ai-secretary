import { createHmac, timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 60;

type LineEvent = {
  type: string;
  mode?: string;
  replyToken?: string;
  source?: {
    type: string;
    userId?: string;
  };
  message?: {
    type: string;
    text?: string;
  };
};
type AIResponse = {
  status?: string;
  output?: Array<{
    type: string;
    content?: Array<{
      type: string;
      text?: string;
      refusal?: string;
    }>;
  }>;
};

async function createReply(message: string, apiKey: string) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-6-luna",
      instructions:
        "あなたはLINEのAI秘書「たくてぃAI」です。" +
        "日本語で親しみやすく、要点から簡潔に答えてください。" +
        "予定の整理、文章作成、相談を手伝います。" +
        "「今日の予定」「明日の予定」とそのまま送ると、専用処理がGoogleのメインカレンダーを日本時間で確認します。それ以外の予定確認では、この2つの送信方法を案内してください。この通常会話には実際の予定データは渡されないので、予定の内容や有無を推測しないでください。予定の登録・変更・削除、会話履歴、メール、外部検索には対応していません。" +
        "実際には行っていない予約、保存、送信、検索を完了したと言わないでください。" +
        "不明なことは不明と伝え、必要なら短く質問してください。",
      input: message,
      reasoning: { effort: "none" },
      max_output_tokens: 1200,
      store: false,
    }),
    signal: AbortSignal.timeout(35000),
  });

  if (!response.ok) {
    console.error("OpenAI request failed:", response.status);
    throw new Error("OpenAI request failed");
  }

  const data: AIResponse = await response.json();

  if (data.status !== "completed" || !Array.isArray(data.output)) {
    throw new Error("OpenAI response incomplete");
  }

  const text = data.output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .map((part) => {
      if (part.type === "output_text") return part.text ?? "";
      if (part.type === "refusal") return part.refusal ?? "";
      return "";
    })
    .join("\n")
    .trim();

  if (!text) throw new Error("OpenAI response empty");

  return text.length > 4500 ? text.slice(0, 4499) + "…" : text;
}

async function calendarReply(message: string): Promise<string | null> {
  const command = message.trim();
  if (command !== "今日の予定" && command !== "明日の予定") {
    return null;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim();

  if (!clientId || !clientSecret || !refreshToken) {
    return "カレンダーの接続設定がまだ反映されていません。";
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });

    if (!tokenResponse.ok) {
      return "Googleとの接続を更新できませんでした。接続設定の確認が必要です。";
    }

    const token = (await tokenResponse.json()) as { access_token?: string };
    if (!token.access_token) throw new Error("Missing access token");

    const dayMs = 86400000;
    const japanOffset = 9 * 60 * 60 * 1000;
    const dayOffset = command === "明日の予定" ? 1 : 0;
    const startMs =
      Math.floor((Date.now() + japanOffset) / dayMs) * dayMs -
      japanOffset +
      dayOffset * dayMs;

    const dateLabel = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    }).format(new Date(startMs));

    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    );
    url.search = new URLSearchParams({
      timeMin: new Date(startMs).toISOString(),
      timeMax: new Date(startMs + dayMs).toISOString(),
      timeZone: "Asia/Tokyo",
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: "21",
      fields: "items(status,summary,location,start,end),nextPageToken",
    }).toString();

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });

    if (!response.ok) {
      return "予定を取得できませんでした。Google側の権限や接続設定を確認してください。";
    }

    type CalendarEvent = {
      status?: string;
      summary?: string;
      location?: string;
      start?: { date?: string; dateTime?: string };
      end?: { date?: string; dateTime?: string };
    };

    const data = (await response.json()) as {
      items?: CalendarEvent[];
      nextPageToken?: string;
    };
    const events = (data.items ?? []).filter(
      (event) => event.status !== "cancelled"
    );
    const heading = `${dateLabel}の予定（日本時間・メインカレンダー）`;

    if (events.length === 0) {
      return data.nextPageToken
        ? `${heading}\n予定一覧を最後まで取得できませんでした。Googleカレンダーでも確認してください。`
        : `${heading}\nこのカレンダーには予定がありません。`;
    }

    const clock = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    const lines = events.slice(0, 20).map((event) => {
      const title = (event.summary || "タイトルなし")
        .replace(/\s+/g, " ")
        .slice(0, 80);
      const location = (event.location || "")
        .replace(/\s+/g, " ")
        .slice(0, 60);

      let time = "時刻未設定";
      if (event.start?.date) {
        time = "終日";
      } else if (event.start?.dateTime) {
        time = clock.format(new Date(event.start.dateTime));
        if (event.end?.dateTime) {
          time += `〜${clock.format(new Date(event.end.dateTime))}`;
        }
      }

      return `・${time} ${title}${location ? `\n  場所：${location}` : ""}`;
    });

    const more =
      events.length > 20 || data.nextPageToken
        ? "\n\n※一部の予定のみ表示しています。続きはGoogleカレンダーで確認してください。"
        : "";

    return `${heading}\n\n${lines.join("\n\n")}${more}`;
  } catch {
    return "予定の取得中に問題が起きました。少し待ってから、もう一度試してください。";
  }
}export async function GET() {
  return Response.json({ status: "ok" });
}

export async function POST(request: Request) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const apiKey = process.env.OPENAI_API_KEY;

  if (!secret || !accessToken || !apiKey) {
    console.error("Required environment variable missing");
    return new Response("Server configuration missing", { status: 500 });
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

  const results = await Promise.allSettled(
    payload.events.map(async (event) => {
      if (
        !event ||
        event.mode === "standby" ||
        event.type !== "message" ||
        event.message?.type !== "text" ||
        typeof event.message.text !== "string" ||
        !event.message.text.trim() ||
        !event.replyToken
      ) {
        return;
      }

      const allowedUserId = process.env.LINE_ALLOWED_USER_ID;

if (
  !allowedUserId ||
  event.source?.type !== "user" ||
  event.source.userId !== allowedUserId
) {
  return;
}

let replyText: string;

      try {
        if (event.message.text.trim() === "カレンダー連携") {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!redirectUri) {
    throw new Error("Google redirect URI missing");
  }

  const expires = String(Math.floor(Date.now() / 1000) + 600);
  const signature = createHmac("sha256", secret)
    .update(`google-connect:${allowedUserId}:${expires}`)
    .digest("hex");

  const connectUrl = new URL("/api/google/start", redirectUri);
  connectUrl.searchParams.set("expires", expires);
  connectUrl.searchParams.set("signature", signature);

  replyText =
    "Googleカレンダーを連携するには、下のリンクをSafariまたはChromeで開いてね。\n" +
    "普段カレンダーを使っているGoogleアカウントで、予定の読み取りを許可してください。\n" +
    "リンクは10分間有効です。他の人には共有しないでね。\n\n" +
    connectUrl.toString();
} else {
 replyText =
  (await calendarReply(event.message.text)) ??
  (await createReply(event.message.text, apiKey));
}
      } catch {
        console.error("AI reply generation failed");
        replyText =
          "ごめんね、今はAIの返事を作れませんでした。少し待ってからもう一度送ってね。";
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
            messages: [{ type: "text", text: replyText }],
          }),
          signal: AbortSignal.timeout(8000),
        }
      );

      if (!response.ok) {
        console.error("LINE reply failed:", response.status);
        throw new Error("LINE reply failed");
      }
    })
  );

  if (results.some((result) => result.status === "rejected")) {
    return new Response("Reply failed", { status: 502 });
  }

  return Response.json({ ok: true });
}
