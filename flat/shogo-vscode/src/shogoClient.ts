import { createShogoLlmProvider } from "@shogo-ai/sdk";
import { streamText, type ModelMessage } from "ai";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StreamOptions {
  apiKey: string;
  model: string;
  apiUrl?: string;
  system: string;
  messages: ChatMessage[];
  onToken: (chunk: string) => void;
  signal?: AbortSignal;
}

export async function streamChat(opts: StreamOptions): Promise<string> {
  const provider = createShogoLlmProvider(
    opts.apiUrl
      ? { apiKey: opts.apiKey, baseUrl: opts.apiUrl }
      : { apiKey: opts.apiKey }
  );

  const coreMessages: ModelMessage[] = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const result = streamText({
    model: provider(opts.model),
    system: opts.system,
    messages: coreMessages,
    abortSignal: opts.signal,
  });

  let full = "";
  for await (const delta of result.textStream) {
    full += delta;
    opts.onToken(delta);
  }

  return full;
}
