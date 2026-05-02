import { cleanTelegramText } from "./telegram-text.js";
import type { AgentMessage } from "./telegram-text.js";

export type UserMessageRef = {
  chatId: number | string;
  messageId: number;
};

export type CompletedTurn = {
  userMessage: UserMessageRef | undefined;
  replyAsVoice: boolean;
  replyText: string;
};

export class TelegramTurnState {
  private activeTurnId: string | undefined;
  private activeUserMessage: UserMessageRef | undefined;
  private busy = false;
  private activeReplyAsVoice = false;
  private readonly chunks: string[] = [];
  private readonly agentMessages: AgentMessage[] = [];

  get isBusy(): boolean {
    return this.busy;
  }

  get turnId(): string | undefined {
    return this.activeTurnId;
  }

  begin(userMessage: UserMessageRef, replyAsVoice: boolean): void {
    this.busy = true;
    this.activeTurnId = undefined;
    this.activeUserMessage = userMessage;
    this.activeReplyAsVoice = replyAsVoice;
    this.chunks.length = 0;
    this.agentMessages.length = 0;
  }

  setReplyAsVoice(replyAsVoice: boolean): void {
    this.activeReplyAsVoice = replyAsVoice;
  }

  setTurnId(turnId: string | undefined): void {
    this.activeTurnId = turnId;
  }

  appendDelta(delta: string): void {
    this.chunks.push(delta);
  }

  appendAgentMessage(message: AgentMessage): void {
    this.agentMessages.push(message);
  }

  failSetup(): void {
    this.busy = false;
    this.activeTurnId = undefined;
    this.activeUserMessage = undefined;
    this.activeReplyAsVoice = false;
    this.chunks.length = 0;
    this.agentMessages.length = 0;
  }

  complete(): CompletedTurn {
    this.busy = false;
    this.activeTurnId = undefined;
    const userMessage = this.activeUserMessage;
    const replyAsVoice = this.activeReplyAsVoice;
    const replyText = this.buildReplyText();
    this.activeUserMessage = undefined;
    this.activeReplyAsVoice = false;
    this.chunks.length = 0;
    this.agentMessages.length = 0;

    return {
      userMessage,
      replyAsVoice,
      replyText,
    };
  }

  private buildReplyText(): string {
    const finalMessages = this.agentMessages
      .filter((message) => message.phase === "final_answer")
      .map((message) => message.text);

    if (finalMessages.length > 0) {
      return cleanTelegramText(finalMessages.join("\n\n"));
    }

    const unknownPhaseMessages = this.agentMessages
      .filter((message) => !message.phase)
      .map((message) => message.text);

    if (unknownPhaseMessages.length > 0) {
      return cleanTelegramText(unknownPhaseMessages.join("\n\n"));
    }

    return cleanTelegramText(this.chunks.join(""));
  }
}
