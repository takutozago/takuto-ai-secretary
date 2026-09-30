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
        "現在は会話履歴、カレンダー、メール、外部検索には接続されていません。" +
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

export async function GET() {
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
  replyText = await createReply(event.message.text, apiKey);
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
