type JsonObject = Record<string, unknown>;

export type ResponsesToolKind = "function" | "custom";

export class ResponsesChatBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponsesChatBridgeError";
  }
}

export interface ChatToolThoughtSignature {
  callID: string;
  name: string;
  arguments: string;
  signature: string;
}

export interface ResponsesRequestTranslationOptions {
  thoughtSignatureForCall?: (
    callID: string,
    name: string,
    arguments_: string,
  ) => string | undefined;
}

export interface ResponsesResponseTranslationOptions {
  onThoughtSignature?: (metadata: ChatToolThoughtSignature) => void;
}

const MAX_THOUGHT_SIGNATURE_BYTES = 128 * 1024;

function record(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResponsesChatBridgeError(`${context} must be an object`);
  }
  return value as JsonObject;
}

function optionalRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function thoughtSignature(call: JsonObject): string | null {
  const google = optionalRecord(optionalRecord(call.extra_content)?.google);
  const value = google?.thought_signature;
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_THOUGHT_SIGNATURE_BYTES
  ) {
    throw new ResponsesChatBridgeError(
      "Chat Completions thought signature is invalid or oversized",
    );
  }
  return value;
}

function textContent(value: unknown, context: string): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw new ResponsesChatBridgeError(`${context} must be text content`);
  }
  return value.map((raw, index) => {
    const block = record(raw, `${context}[${index}]`);
    if (
      (block.type === "input_text" ||
        block.type === "output_text" ||
        block.type === "text") &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
    throw new ResponsesChatBridgeError(
      `${context} contains unsupported block ${JSON.stringify(block.type)}`,
    );
  }).join("\n");
}

function toolOutput(value: unknown, context: string): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return textContent(value, context);
  return JSON.stringify(value);
}

function assistantToolMessage(
  callID: string,
  name: string,
  arguments_: string,
  signature: string | undefined,
): JsonObject {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: callID,
      type: "function",
      function: { name, arguments: arguments_ },
      ...(signature === undefined
        ? {}
        : {
          extra_content: {
            google: { thought_signature: signature },
          },
        }),
    }],
  };
}

function translateInputItem(
  item: JsonObject,
  index: number,
  options: ResponsesRequestTranslationOptions,
): JsonObject[] {
  const context = `Responses input[${index}]`;
  if (item.type === "additional_tools" || item.type === "reasoning") return [];
  if (item.type === "message") {
    if (
      item.role !== "system" &&
      item.role !== "developer" &&
      item.role !== "user" &&
      item.role !== "assistant"
    ) {
      throw new ResponsesChatBridgeError(
        `${context} has unsupported role ${JSON.stringify(item.role)}`,
      );
    }
    return [{
      role: item.role === "developer" ? "system" : item.role,
      content: textContent(item.content, `${context} content`),
    }];
  }
  if (item.type === "function_call") {
    if (
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.arguments !== "string"
    ) {
      throw new ResponsesChatBridgeError(`${context} function_call is incomplete`);
    }
    return [assistantToolMessage(
      item.call_id,
      item.name,
      item.arguments,
      options.thoughtSignatureForCall?.(
        item.call_id,
        item.name,
        item.arguments,
      ),
    )];
  }
  if (item.type === "custom_tool_call") {
    if (
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.input !== "string"
    ) {
      throw new ResponsesChatBridgeError(`${context} custom_tool_call is incomplete`);
    }
    return [assistantToolMessage(
      item.call_id,
      item.name,
      JSON.stringify({ input: item.input }),
      options.thoughtSignatureForCall?.(
        item.call_id,
        item.name,
        JSON.stringify({ input: item.input }),
      ),
    )];
  }
  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    if (typeof item.call_id !== "string") {
      throw new ResponsesChatBridgeError(`${context} tool output is incomplete`);
    }
    return [{
      role: "tool",
      tool_call_id: item.call_id,
      content: toolOutput(item.output, `${context} output`),
    }];
  }
  throw new ResponsesChatBridgeError(
    `${context} has unsupported type ${JSON.stringify(item.type)}`,
  );
}

function responsesTools(input: JsonObject): JsonObject[] {
  const tools: JsonObject[] = [];
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) {
      throw new ResponsesChatBridgeError("Responses tools must be an array");
    }
    tools.push(...input.tools.map((tool, index) =>
      record(tool, `Responses tools[${index}]`)
    ));
  }
  if (Array.isArray(input.input)) {
    for (const [index, raw] of input.input.entries()) {
      const item = record(raw, `Responses input[${index}]`);
      if (item.type !== "additional_tools") continue;
      if (!Array.isArray(item.tools)) {
        throw new ResponsesChatBridgeError(
          `Responses input[${index}] additional_tools must contain tools`,
        );
      }
      tools.push(...item.tools.map((tool, toolIndex) =>
        record(tool, `Responses input[${index}] tools[${toolIndex}]`)
      ));
    }
  }
  return tools;
}

function translateTools(
  input: JsonObject,
): { tools: JsonObject[]; kinds: ReadonlyMap<string, ResponsesToolKind> } {
  const translated: JsonObject[] = [];
  const kinds = new Map<string, ResponsesToolKind>();
  for (const [index, tool] of responsesTools(input).entries()) {
    if (tool.type === "namespace" || tool.type === "web_search") {
      // Codex can advertise product-native capabilities that a generic Chat
      // Completions endpoint cannot execute. Omitting them narrows authority;
      // pretending to translate them would create a false capability boundary.
      continue;
    }
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      throw new ResponsesChatBridgeError(`Responses tool[${index}] name is required`);
    }
    if (kinds.has(tool.name)) {
      throw new ResponsesChatBridgeError(`Duplicate Responses tool ${tool.name}`);
    }
    if (tool.type === "function") {
      kinds.set(tool.name, "function");
      translated.push({
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string"
            ? { description: tool.description }
            : {}),
          parameters: record(tool.parameters ?? {}, `Responses tool[${index}] parameters`),
        },
      });
      continue;
    }
    if (tool.type === "custom") {
      kinds.set(tool.name, "custom");
      translated.push({
        type: "function",
        function: {
          name: tool.name,
          description: [
            typeof tool.description === "string" ? tool.description : "",
            "Return the custom tool's complete raw input in the JSON field `input`.",
          ].filter(Boolean).join("\n\n"),
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      });
      continue;
    }
    throw new ResponsesChatBridgeError(
      `Unsupported Responses tool type ${JSON.stringify(tool.type)}`,
    );
  }
  return { tools: translated, kinds };
}

function translateToolChoice(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "none" || value === "required") return value;
  const choice = record(value, "Responses tool_choice");
  if (
    (choice.type === "function" || choice.type === "custom") &&
    typeof choice.name === "string"
  ) {
    return { type: "function", function: { name: choice.name } };
  }
  throw new ResponsesChatBridgeError("Unsupported Responses tool_choice");
}

export interface ResponsesRequestTranslation {
  requestedModel: string;
  stream: boolean;
  body: JsonObject;
  toolKinds: ReadonlyMap<string, ResponsesToolKind>;
}

export function responsesToChatCompletions(
  value: unknown,
  fixedModel: string,
  options: ResponsesRequestTranslationOptions = {},
): ResponsesRequestTranslation {
  const input = record(value, "Responses request");
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    throw new ResponsesChatBridgeError("Responses model is required");
  }
  const messages: JsonObject[] = [];
  if (typeof input.instructions === "string" && input.instructions.length > 0) {
    messages.push({ role: "system", content: input.instructions });
  }
  if (typeof input.input === "string") {
    messages.push({ role: "user", content: input.input });
  } else if (Array.isArray(input.input)) {
    for (const [index, raw] of input.input.entries()) {
      messages.push(...translateInputItem(
        record(raw, `Responses input[${index}]`),
        index,
        options,
      ));
    }
  } else {
    throw new ResponsesChatBridgeError("Responses input must be text or an array");
  }
  if (messages.length === 0) {
    throw new ResponsesChatBridgeError("Responses request contains no messages");
  }
  const { tools, kinds } = translateTools(input);
  const toolChoice = translateToolChoice(input.tool_choice);
  const stream = input.stream === true;
  return {
    requestedModel: input.model,
    stream,
    toolKinds: kinds,
    body: {
      model: fixedModel,
      messages,
      stream,
      ...(typeof input.max_output_tokens === "number"
        ? { max_tokens: input.max_output_tokens }
        : {}),
      ...(typeof input.temperature === "number"
        ? { temperature: input.temperature }
        : {}),
      ...(typeof input.top_p === "number" ? { top_p: input.top_p } : {}),
      ...(typeof input.parallel_tool_calls === "boolean"
        ? { parallel_tool_calls: input.parallel_tool_calls }
        : {}),
      ...(tools.length === 0 ? {} : { tools }),
      ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    },
  };
}

function firstChoice(value: JsonObject): JsonObject {
  if (!Array.isArray(value.choices) || value.choices.length === 0) {
    throw new ResponsesChatBridgeError("Chat Completions response has no choices");
  }
  return record(value.choices[0], "Chat Completions choice");
}

function responseUsage(value: unknown): JsonObject {
  const usage = typeof value === "object" && value !== null
    ? value as JsonObject
    : {};
  const inputTokens = typeof usage.prompt_tokens === "number"
    ? usage.prompt_tokens
    : 0;
  const outputTokens = typeof usage.completion_tokens === "number"
    ? usage.completion_tokens
    : 0;
  const completionDetails = typeof usage.completion_tokens_details === "object" &&
      usage.completion_tokens_details !== null
    ? usage.completion_tokens_details as JsonObject
    : {};
  const promptDetails = typeof usage.prompt_tokens_details === "object" &&
      usage.prompt_tokens_details !== null
    ? usage.prompt_tokens_details as JsonObject
    : {};
  const providerTotal = typeof usage.total_tokens === "number"
    ? usage.total_tokens
    : inputTokens + outputTokens;
  // Some OpenAI-compatible providers (notably Gemini) include internal
  // thinking tokens in total_tokens while omitting them from
  // completion_tokens and completion_tokens_details. Responses semantics
  // require reasoning to be a subset of output, so preserve the provider
  // total by attributing only the otherwise-unaccounted positive delta.
  const unattributedOutputTokens = Math.max(
    0,
    providerTotal - inputTokens - outputTokens,
  );
  const normalizedOutputTokens = outputTokens + unattributedOutputTokens;
  const explicitReasoningTokens =
    typeof completionDetails.reasoning_tokens === "number"
      ? completionDetails.reasoning_tokens
      : 0;
  const reasoningTokens = Math.min(
    normalizedOutputTokens,
    Math.max(explicitReasoningTokens, unattributedOutputTokens),
  );
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: typeof promptDetails.cached_tokens === "number"
        ? promptDetails.cached_tokens
        : 0,
    },
    output_tokens: normalizedOutputTokens,
    output_tokens_details: {
      reasoning_tokens: reasoningTokens,
    },
    total_tokens: inputTokens + normalizedOutputTokens,
  };
}

function customInput(arguments_: string): string {
  try {
    const parsed = record(JSON.parse(arguments_), "Custom tool arguments");
    if (typeof parsed.input !== "string") {
      throw new ResponsesChatBridgeError("Custom tool input must be a string");
    }
    return parsed.input;
  } catch (error) {
    if (error instanceof ResponsesChatBridgeError) throw error;
    throw new ResponsesChatBridgeError("Custom tool arguments are not valid JSON");
  }
}

function itemID(callID: string, kind: ResponsesToolKind): string {
  const safe = callID.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  return `${kind === "custom" ? "ctc" : "fc"}_${safe}`;
}

function toolOutputItem(
  callID: string,
  name: string,
  arguments_: string,
  kind: ResponsesToolKind,
  status: "in_progress" | "completed",
): JsonObject {
  if (kind === "custom") {
    return {
      id: itemID(callID, kind),
      type: "custom_tool_call",
      status,
      call_id: callID,
      name,
      input: status === "completed" ? customInput(arguments_) : "",
    };
  }
  return {
    id: itemID(callID, kind),
    type: "function_call",
    status,
    call_id: callID,
    name,
    arguments: status === "completed" ? arguments_ : "",
  };
}

function messageItem(id: string, text: string, completed: boolean): JsonObject {
  return {
    id,
    type: "message",
    status: completed ? "completed" : "in_progress",
    role: "assistant",
    content: completed
      ? [{ type: "output_text", text, annotations: [], logprobs: [] }]
      : [],
  };
}

function responseObject(
  id: string,
  model: string,
  status: "in_progress" | "completed",
  output: JsonObject[],
  usage: JsonObject | null,
): JsonObject {
  const completed = status === "completed";
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    completed_at: completed ? Math.floor(Date.now() / 1000) : null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: null,
    text: { format: { type: "text" }, verbosity: "medium" },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage,
    user: null,
    metadata: {},
  };
}

export function chatCompletionToResponse(
  value: unknown,
  requestedModel: string,
  toolKinds: ReadonlyMap<string, ResponsesToolKind>,
  options: ResponsesResponseTranslationOptions = {},
): JsonObject {
  const response = record(value, "Chat Completions response");
  const choice = firstChoice(response);
  const message = record(choice.message, "Chat Completions message");
  const id = typeof response.id === "string"
    ? response.id.replace(/^chatcmpl-/, "resp_")
    : "resp_organum_code_bridge";
  const output: JsonObject[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    output.push(messageItem(`${id}_message`, message.content, true));
  }
  if (Array.isArray(message.tool_calls)) {
    for (const [index, raw] of message.tool_calls.entries()) {
      const call = record(raw, `Chat Completions tool_calls[${index}]`);
      const fn = record(call.function, `Chat Completions tool_calls[${index}] function`);
      if (
        typeof call.id !== "string" ||
        typeof fn.name !== "string" ||
        typeof fn.arguments !== "string"
      ) {
        throw new ResponsesChatBridgeError("Chat Completions tool call is incomplete");
      }
      const item = toolOutputItem(
        call.id,
        fn.name,
        fn.arguments,
        toolKinds.get(fn.name) ?? "function",
        "completed",
      );
      output.push(item);
      const signature = thoughtSignature(call);
      if (signature !== null) {
        options.onThoughtSignature?.({
          callID: call.id,
          name: fn.name,
          arguments: fn.arguments,
          signature,
        });
      }
    }
  }
  return responseObject(
    id,
    requestedModel,
    "completed",
    output,
    responseUsage(response.usage),
  );
}

export interface ResponsesSseEvent {
  event: string;
  data: JsonObject;
}

interface StreamToolCall {
  index: number;
  outputIndex: number;
  callID: string;
  name: string;
  arguments: string;
  emittedArguments: number;
  kind: ResponsesToolKind;
  added: boolean;
  thoughtSignature: string | null;
}

export class ChatCompletionResponsesStream {
  #responseID = "resp_organum_code_bridge";
  #messageID = "msg_organum_code_bridge";
  #requestedModel: string;
  #toolKinds: ReadonlyMap<string, ResponsesToolKind>;
  #sequence = 0;
  #started = false;
  #finished = false;
  #messageAdded = false;
  #text = "";
  #nextOutputIndex = 0;
  #messageOutputIndex = -1;
  #tools = new Map<number, StreamToolCall>();
  #usage: JsonObject = responseUsage(null);
  #onThoughtSignature: ((metadata: ChatToolThoughtSignature) => void) | undefined;

  constructor(
    requestedModel: string,
    toolKinds: ReadonlyMap<string, ResponsesToolKind>,
    options: ResponsesResponseTranslationOptions = {},
  ) {
    this.#requestedModel = requestedModel;
    this.#toolKinds = toolKinds;
    this.#onThoughtSignature = options.onThoughtSignature;
  }

  #event(event: string, data: JsonObject): ResponsesSseEvent {
    return {
      event,
      data: { ...data, sequence_number: this.#sequence++ },
    };
  }

  #start(): ResponsesSseEvent[] {
    if (this.#started) return [];
    this.#started = true;
    return [this.#event("response.created", {
      type: "response.created",
      response: responseObject(
        this.#responseID,
        this.#requestedModel,
        "in_progress",
        [],
        null,
      ),
    })];
  }

  #addMessage(events: ResponsesSseEvent[]): void {
    if (this.#messageAdded) return;
    this.#messageAdded = true;
    this.#messageOutputIndex = this.#nextOutputIndex++;
    events.push(this.#event("response.output_item.added", {
      type: "response.output_item.added",
      output_index: this.#messageOutputIndex,
      item: messageItem(this.#messageID, "", false),
    }));
    events.push(this.#event("response.content_part.added", {
      type: "response.content_part.added",
      item_id: this.#messageID,
      output_index: this.#messageOutputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
    }));
  }

  #addTool(call: StreamToolCall, events: ResponsesSseEvent[]): void {
    if (call.added || call.callID.length === 0 || call.name.length === 0) return;
    call.added = true;
    events.push(this.#event("response.output_item.added", {
      type: "response.output_item.added",
      output_index: call.outputIndex,
      item: toolOutputItem(
        call.callID,
        call.name,
        call.arguments,
        call.kind,
        "in_progress",
      ),
    }));
  }

  #toolCallIndex(
    part: JsonObject,
    position: number,
    callsInChunk: number,
  ): number {
    if (
      typeof part.index === "number" &&
      Number.isSafeInteger(part.index) &&
      part.index >= 0
    ) {
      return part.index;
    }
    const callID = typeof part.id === "string" ? part.id : "";
    if (callID.length > 0) {
      const matched = [...this.#tools.values()].find(
        (candidate) => candidate.callID === callID,
      );
      if (matched !== undefined) return matched.index;
    }
    if (callsInChunk > 1 && !this.#tools.has(position)) return position;
    if (callID.length > 0) {
      let candidate = 0;
      while (this.#tools.has(candidate)) candidate += 1;
      return candidate;
    }
    if (this.#tools.size === 0) return 0;
    if (this.#tools.size === 1) return this.#tools.keys().next().value!;
    throw new ResponsesChatBridgeError(
      "Stream tool call index is required when the call is ambiguous",
    );
  }

  push(value: unknown): ResponsesSseEvent[] {
    if (this.#finished) return [];
    const chunk = record(value, "Chat Completions stream chunk");
    if (typeof chunk.id === "string") {
      this.#responseID = chunk.id.replace(/^chatcmpl-/, "resp_");
      this.#messageID = `${this.#responseID}_message`;
    }
    const events = this.#start();
    if (chunk.usage !== undefined) this.#usage = responseUsage(chunk.usage);
    if (!Array.isArray(chunk.choices)) return events;
    for (const rawChoice of chunk.choices) {
      const choice = record(rawChoice, "Chat Completions stream choice");
      const delta = record(choice.delta ?? {}, "Chat Completions stream delta");
      if (typeof delta.content === "string" && delta.content.length > 0) {
        this.#addMessage(events);
        this.#text += delta.content;
        events.push(this.#event("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: this.#messageID,
          output_index: this.#messageOutputIndex,
          content_index: 0,
          delta: delta.content,
          logprobs: [],
        }));
      }
      if (!Array.isArray(delta.tool_calls)) continue;
      for (const [position, rawCall] of delta.tool_calls.entries()) {
        const part = record(rawCall, "Chat Completions stream tool call");
        const index = this.#toolCallIndex(
          part,
          position,
          delta.tool_calls.length,
        );
        let call = this.#tools.get(index);
        if (call === undefined) {
          call = {
            index,
            outputIndex: this.#nextOutputIndex++,
            callID: "",
            name: "",
            arguments: "",
            emittedArguments: 0,
            kind: "function",
            added: false,
            thoughtSignature: null,
          };
          this.#tools.set(index, call);
        }
        if (typeof part.id === "string" && part.id.length > 0) call.callID = part.id;
        const signature = thoughtSignature(part);
        if (signature !== null) call.thoughtSignature = signature;
        const fn = record(part.function ?? {}, "Chat Completions stream tool function");
        if (typeof fn.name === "string" && fn.name.length > 0) {
          call.name = fn.name;
          call.kind = this.#toolKinds.get(fn.name) ?? "function";
        }
        if (typeof fn.arguments === "string") call.arguments += fn.arguments;
        this.#addTool(call, events);
        if (
          call.added &&
          call.kind === "function" &&
          call.arguments.length > call.emittedArguments
        ) {
          const fragment = call.arguments.slice(call.emittedArguments);
          call.emittedArguments = call.arguments.length;
          events.push(this.#event("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: itemID(call.callID, call.kind),
            output_index: call.outputIndex,
            delta: fragment,
          }));
        }
      }
    }
    return events;
  }

  finish(): ResponsesSseEvent[] {
    if (this.#finished) return [];
    this.#finished = true;
    const events = this.#start();
    const output: JsonObject[] = [];
    if (this.#messageAdded) {
      const item = messageItem(this.#messageID, this.#text, true);
      output.push(item);
      events.push(this.#event("response.output_text.done", {
        type: "response.output_text.done",
        item_id: this.#messageID,
        output_index: this.#messageOutputIndex,
        content_index: 0,
        text: this.#text,
        logprobs: [],
      }));
      events.push(this.#event("response.content_part.done", {
        type: "response.content_part.done",
        item_id: this.#messageID,
        output_index: this.#messageOutputIndex,
        content_index: 0,
        part: Array.isArray(item.content) ? item.content[0] as JsonObject : {},
      }));
      events.push(this.#event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: this.#messageOutputIndex,
        item,
      }));
    }
    for (const call of [...this.#tools.values()].sort((a, b) =>
      a.outputIndex - b.outputIndex
    )) {
      this.#addTool(call, events);
      if (!call.added) {
        throw new ResponsesChatBridgeError("Stream tool call is incomplete");
      }
      if (call.kind === "custom") {
        const input = customInput(call.arguments);
        events.push(this.#event("response.custom_tool_call_input.delta", {
          type: "response.custom_tool_call_input.delta",
          item_id: itemID(call.callID, call.kind),
          output_index: call.outputIndex,
          delta: input,
        }));
        events.push(this.#event("response.custom_tool_call_input.done", {
          type: "response.custom_tool_call_input.done",
          item_id: itemID(call.callID, call.kind),
          output_index: call.outputIndex,
          input,
        }));
      } else {
        events.push(this.#event("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item_id: itemID(call.callID, call.kind),
          output_index: call.outputIndex,
          name: call.name,
          arguments: call.arguments,
        }));
      }
      const item = toolOutputItem(
        call.callID,
        call.name,
        call.arguments,
        call.kind,
        "completed",
      );
      output.push(item);
      events.push(this.#event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: call.outputIndex,
        item,
      }));
      if (call.thoughtSignature !== null) {
        this.#onThoughtSignature?.({
          callID: call.callID,
          name: call.name,
          arguments: call.arguments,
          signature: call.thoughtSignature,
        });
      }
    }
    output.sort((a, b) => {
      const index = (item: JsonObject): number => {
        if (item.type === "message") return this.#messageOutputIndex;
        const call = [...this.#tools.values()].find((candidate) =>
          item.call_id === candidate.callID
        );
        return call?.outputIndex ?? Number.MAX_SAFE_INTEGER;
      };
      return index(a) - index(b);
    });
    events.push(this.#event("response.completed", {
      type: "response.completed",
      response: responseObject(
        this.#responseID,
        this.#requestedModel,
        "completed",
        output,
        this.#usage,
      ),
    }));
    return events;
  }
}
