type JsonObject = Record<string, unknown>;

export class AnthropicChatBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnthropicChatBridgeError";
  }
}

function record(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AnthropicChatBridgeError(`${context} must be an object`);
  }
  return value as JsonObject;
}

function textContent(value: unknown, context: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw new AnthropicChatBridgeError(`${context} must be text content`);
  }
  return value
    .map((item, index) => {
      const block = record(item, `${context}[${index}]`);
      if (block.type !== "text" || typeof block.text !== "string") {
        throw new AnthropicChatBridgeError(
          `${context} contains an unsupported non-text block`,
        );
      }
      return block.text;
    })
    .join("\n");
}

function translateUserContent(value: unknown): JsonObject[] {
  if (typeof value === "string") return [{ role: "user", content: value }];
  if (!Array.isArray(value)) {
    throw new AnthropicChatBridgeError("Anthropic user content must be an array or string");
  }
  const messages: JsonObject[] = [];
  let text: string[] = [];
  const flushText = (): void => {
    if (text.length === 0) return;
    messages.push({ role: "user", content: text.join("\n") });
    text = [];
  };
  for (const [index, item] of value.entries()) {
    const block = record(item, `Anthropic user content[${index}]`);
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      continue;
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      flushText();
      messages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: textContent(block.content ?? "", "Anthropic tool_result content"),
      });
      continue;
    }
    throw new AnthropicChatBridgeError(
      `Anthropic user content contains unsupported block ${JSON.stringify(block.type)}`,
    );
  }
  flushText();
  return messages;
}

function translateAssistantContent(value: unknown): JsonObject {
  if (typeof value === "string") return { role: "assistant", content: value };
  if (!Array.isArray(value)) {
    throw new AnthropicChatBridgeError(
      "Anthropic assistant content must be an array or string",
    );
  }
  const text: string[] = [];
  const toolCalls: JsonObject[] = [];
  for (const [index, item] of value.entries()) {
    const block = record(item, `Anthropic assistant content[${index}]`);
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      continue;
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      continue;
    }
    if (
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
    ) {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(record(block.input, "Anthropic tool_use input")),
        },
      });
      continue;
    }
    throw new AnthropicChatBridgeError(
      `Anthropic assistant content contains unsupported block ${JSON.stringify(block.type)}`,
    );
  }
  return {
    role: "assistant",
    content: text.length === 0 ? null : text.join("\n"),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  };
}

function translateToolChoice(value: unknown): unknown {
  if (value === undefined) return undefined;
  const choice = record(value, "Anthropic tool_choice");
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && typeof choice.name === "string") {
    return { type: "function", function: { name: choice.name } };
  }
  throw new AnthropicChatBridgeError("Unsupported Anthropic tool_choice");
}

export interface AnthropicRequestTranslation {
  requestedModel: string;
  stream: boolean;
  body: JsonObject;
}

export function anthropicMessagesToChatCompletions(
  value: unknown,
  fixedModel: string,
): AnthropicRequestTranslation {
  const input = record(value, "Anthropic Messages request");
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    throw new AnthropicChatBridgeError("Anthropic Messages model is required");
  }
  if (!Array.isArray(input.messages)) {
    throw new AnthropicChatBridgeError("Anthropic Messages messages must be an array");
  }
  const messages: JsonObject[] = [];
  if (input.system !== undefined) {
    messages.push({
      role: "system",
      content: textContent(input.system, "Anthropic system"),
    });
  }
  for (const [index, item] of input.messages.entries()) {
    const message = record(item, `Anthropic messages[${index}]`);
    if (message.role === "user") {
      messages.push(...translateUserContent(message.content));
      continue;
    }
    if (message.role === "assistant") {
      messages.push(translateAssistantContent(message.content));
      continue;
    }
    throw new AnthropicChatBridgeError(
      `Unsupported Anthropic message role ${JSON.stringify(message.role)}`,
    );
  }

  let tools: JsonObject[] | undefined;
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) {
      throw new AnthropicChatBridgeError("Anthropic tools must be an array");
    }
    tools = input.tools.map((item, index) => {
      const tool = record(item, `Anthropic tools[${index}]`);
      if (typeof tool.name !== "string") {
        throw new AnthropicChatBridgeError("Anthropic tool name is required");
      }
      return {
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string"
            ? { description: tool.description }
            : {}),
          parameters: record(tool.input_schema, "Anthropic tool input_schema"),
        },
      };
    });
  }
  const toolChoice = translateToolChoice(input.tool_choice);
  const stream = input.stream === true;
  return {
    requestedModel: input.model,
    stream,
    body: {
      model: fixedModel,
      messages,
      stream,
      ...(typeof input.max_tokens === "number"
        ? { max_tokens: input.max_tokens }
        : {}),
      ...(typeof input.temperature === "number"
        ? { temperature: input.temperature }
        : {}),
      ...(typeof input.top_p === "number" ? { top_p: input.top_p } : {}),
      ...(Array.isArray(input.stop_sequences)
        ? { stop: input.stop_sequences }
        : {}),
      ...(tools === undefined ? {} : { tools }),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    },
  };
}

function stopReason(value: unknown): "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" {
  if (value === "length") return "max_tokens";
  if (value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "stop") return "end_turn";
  return "end_turn";
}

function parseArguments(value: unknown): JsonObject {
  if (typeof value !== "string") return {};
  try {
    return record(JSON.parse(value), "OpenAI tool arguments");
  } catch {
    throw new AnthropicChatBridgeError("OpenAI tool arguments are not valid JSON");
  }
}

export function chatCompletionToAnthropicMessage(
  value: unknown,
  requestedModel: string,
): JsonObject {
  const response = record(value, "Chat Completions response");
  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw new AnthropicChatBridgeError("Chat Completions response has no choices");
  }
  const choice = record(response.choices[0], "Chat Completions choice");
  const message = record(choice.message, "Chat Completions message");
  const content: JsonObject[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  if (Array.isArray(message.tool_calls)) {
    for (const [index, item] of message.tool_calls.entries()) {
      const call = record(item, `Chat Completions tool_calls[${index}]`);
      const fn = record(call.function, "Chat Completions tool function");
      if (typeof call.id !== "string" || typeof fn.name !== "string") {
        throw new AnthropicChatBridgeError("Chat Completions tool call is incomplete");
      }
      content.push({
        type: "tool_use",
        id: call.id,
        name: fn.name,
        input: parseArguments(fn.arguments),
      });
    }
  }
  const usage =
    typeof response.usage === "object" && response.usage !== null
      ? (response.usage as JsonObject)
      : {};
  return {
    id:
      typeof response.id === "string"
        ? response.id
        : "msg_organum_code_bridge",
    type: "message",
    role: "assistant",
    model: requestedModel,
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens:
        typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
      output_tokens:
        typeof usage.completion_tokens === "number"
          ? usage.completion_tokens
          : 0,
    },
  };
}

export interface AnthropicSseEvent {
  event: string;
  data: JsonObject;
}

export interface AnthropicNativeToolProposal {
  nativeToolCallId: string;
  nativeToolName: string;
  toolArguments: JsonObject;
}

interface StreamBlock {
  anthropicIndex: number;
  kind: "text" | "tool";
  toolIndex?: number;
  nativeToolCallId?: string;
  nativeToolName?: string;
  argumentFragments?: string[];
}

export class ChatCompletionAnthropicStream {
  #started = false;
  #stopped = false;
  #nextBlock = 0;
  #textBlock: StreamBlock | null = null;
  #toolBlocks = new Map<number, StreamBlock>();
  #requestedModel: string;
  #messageID = "msg_organum_code_bridge";
  #inputTokens = 0;
  #outputTokens = 0;

  constructor(requestedModel: string) {
    this.#requestedModel = requestedModel;
  }

  push(value: unknown): AnthropicSseEvent[] {
    if (this.#stopped) return [];
    const chunk = record(value, "Chat Completions stream chunk");
    if (typeof chunk.id === "string") this.#messageID = chunk.id;
    const events = this.#startEvents();
    const usage =
      typeof chunk.usage === "object" && chunk.usage !== null
        ? (chunk.usage as JsonObject)
        : null;
    if (usage !== null) {
      if (typeof usage.prompt_tokens === "number") {
        this.#inputTokens = usage.prompt_tokens;
      }
      if (typeof usage.completion_tokens === "number") {
        this.#outputTokens = usage.completion_tokens;
      }
    }
    if (!Array.isArray(chunk.choices)) return events;
    for (const rawChoice of chunk.choices) {
      const choice = record(rawChoice, "Chat Completions stream choice");
      const delta = record(choice.delta ?? {}, "Chat Completions stream delta");
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (this.#textBlock === null) {
          this.#textBlock = {
            anthropicIndex: this.#nextBlock++,
            kind: "text",
          };
          events.push({
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: this.#textBlock.anthropicIndex,
              content_block: { type: "text", text: "" },
            },
          });
        }
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: this.#textBlock.anthropicIndex,
            delta: { type: "text_delta", text: delta.content },
          },
        });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const rawCall of delta.tool_calls) {
          const call = record(rawCall, "Chat Completions stream tool call");
          if (typeof call.index !== "number") {
            throw new AnthropicChatBridgeError("Stream tool call index is required");
          }
          const fn = record(call.function ?? {}, "Stream tool function");
          let block = this.#toolBlocks.get(call.index);
          if (block === undefined) {
            if (typeof call.id !== "string" || typeof fn.name !== "string") {
              throw new AnthropicChatBridgeError(
                "First stream tool fragment requires id and name",
              );
            }
            block = {
              anthropicIndex: this.#nextBlock++,
              kind: "tool",
              toolIndex: call.index,
              nativeToolCallId: call.id,
              nativeToolName: fn.name,
              argumentFragments: [],
            };
            this.#toolBlocks.set(call.index, block);
            events.push({
              event: "content_block_start",
              data: {
                type: "content_block_start",
                index: block.anthropicIndex,
                content_block: {
                  type: "tool_use",
                  id: call.id,
                  name: fn.name,
                  input: {},
                },
              },
            });
          } else if (
            (call.id !== undefined &&
              call.id !== block.nativeToolCallId) ||
            (fn.name !== undefined &&
              fn.name !== block.nativeToolName)
          ) {
            throw new AnthropicChatBridgeError(
              "Stream tool call identity changed between fragments",
            );
          }
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
            block.argumentFragments!.push(fn.arguments);
            events.push({
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index: block.anthropicIndex,
                delta: {
                  type: "input_json_delta",
                  partial_json: fn.arguments,
                },
              },
            });
          }
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        events.push(...this.finish(stopReason(choice.finish_reason)));
      }
    }
    return events;
  }

  nativeToolProposals(): AnthropicNativeToolProposal[] {
    return [...this.#toolBlocks.values()]
      .sort((left, right) =>
        (left.toolIndex ?? 0) - (right.toolIndex ?? 0)
      )
      .map((block) => {
        if (
          block.kind !== "tool" ||
          block.nativeToolCallId === undefined ||
          block.nativeToolName === undefined
        ) {
          throw new AnthropicChatBridgeError(
            "Stream tool call is incomplete",
          );
        }
        const serialized = (block.argumentFragments ?? []).join("");
        let toolArguments: JsonObject;
        try {
          toolArguments = record(
            JSON.parse(serialized.length === 0 ? "{}" : serialized),
            "Stream tool arguments",
          );
        } catch (error) {
          if (error instanceof AnthropicChatBridgeError) throw error;
          throw new AnthropicChatBridgeError(
            "Stream tool arguments are not valid JSON",
          );
        }
        return {
          nativeToolCallId: block.nativeToolCallId,
          nativeToolName: block.nativeToolName,
          toolArguments,
        };
      });
  }

  hasTextContent(): boolean {
    return this.#textBlock !== null;
  }

  finish(
    reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" = "end_turn",
  ): AnthropicSseEvent[] {
    if (this.#stopped) return [];
    const events = this.#startEvents();
    const blocks = [
      ...(this.#textBlock === null ? [] : [this.#textBlock]),
      ...this.#toolBlocks.values(),
    ].sort((left, right) => left.anthropicIndex - right.anthropicIndex);
    for (const block of blocks) {
      events.push({
        event: "content_block_stop",
        data: { type: "content_block_stop", index: block.anthropicIndex },
      });
    }
    events.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: reason, stop_sequence: null },
        usage: { output_tokens: this.#outputTokens },
      },
    });
    events.push({ event: "message_stop", data: { type: "message_stop" } });
    this.#stopped = true;
    return events;
  }

  #startEvents(): AnthropicSseEvent[] {
    if (this.#started) return [];
    this.#started = true;
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: this.#messageID,
            type: "message",
            role: "assistant",
            model: this.#requestedModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: this.#inputTokens, output_tokens: 0 },
          },
        },
      },
    ];
  }
}

export function anthropicMessageNativeToolProposals(
  message: Readonly<JsonObject>,
): AnthropicNativeToolProposal[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((item, index) => {
    const block = record(item, `Anthropic message content[${index}]`);
    if (block.type !== "tool_use") return [];
    if (
      typeof block.id !== "string" ||
      typeof block.name !== "string"
    ) {
      throw new AnthropicChatBridgeError(
        "Anthropic tool proposal is incomplete",
      );
    }
    return [{
      nativeToolCallId: block.id,
      nativeToolName: block.name,
      toolArguments: record(
        block.input,
        "Anthropic tool proposal input",
      ),
    }];
  });
}

export function anthropicMessageHasTextContent(
  message: Readonly<JsonObject>,
): boolean {
  return Array.isArray(message.content) &&
    message.content.some((item, index) => {
      const block = record(item, `Anthropic message content[${index}]`);
      return block.type === "text" &&
        typeof block.text === "string" &&
        block.text.length > 0;
    });
}

export function approximateAnthropicInputTokens(value: unknown): number {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  return Math.max(1, Math.ceil(bytes / 4));
}
