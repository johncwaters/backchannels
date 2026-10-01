import type { MessageView } from "./store";

export function previewMessage(message: MessageView, maxChars: number): MessageView {
  if (message.text.length <= maxChars) return message;
  const splitsSurrogatePair = /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(message.text.slice(maxChars - 1, maxChars + 1));
  const previewEnd = splitsSurrogatePair ? maxChars - 1 : maxChars;
  return { ...message, text: message.text.slice(0, previewEnd), text_truncated: true, text_length: message.text.length };
}

type PreviewState = { text_truncated?: boolean; files?: readonly unknown[] };

export function messagePreviewHint(messages: PreviewState[]): { hint?: string } {
  return messages.some(message => message.text_truncated || message.files?.length)
    ? { hint: "Some message or attachment text is omitted; pass the message ID as conversation to read_messages for full text. Use detail: 'full' for available inline attachment text." }
    : {};
}
