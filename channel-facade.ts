import type { MessageMetadata } from './channel-values.js';
import type { MetadataMatch } from './channel-metadata.js';
import type { MessageId } from './message.js';

export type ChannelTruncate = number | false;
export interface ChannelSendInput {
  readonly from: string;
  readonly to: string | readonly string[];
  readonly body: string;
  readonly truncate?: ChannelTruncate;
  readonly metadata?: MessageMetadata;
}
export interface ChannelSendResult {
  readonly id: MessageId;
  readonly at: number;
  readonly from: string;
  readonly to: readonly string[];
  readonly body: string;
  readonly metadata?: MessageMetadata;
}
export interface ChannelEndpointSummary {
  readonly name: string;
  readonly generation: string;
  readonly attachment: 'attached' | 'detached';
  readonly deliveryAvailable: boolean;
  readonly unreadCount: number;
  readonly lastActiveAt?: number;
}
export interface ChannelMessage {
  readonly id: MessageId;
  readonly at: number;
  readonly from: string;
  readonly to: readonly string[];
  readonly body: string;
  readonly metadata?: MessageMetadata;
}
export interface ChannelPendingResult { readonly messages: readonly ChannelMessage[]; readonly remaining: number }
export interface MessageCursor { readonly id: MessageId; readonly direction: 'before' | 'after' }
export interface MessageSearch { readonly text: string; readonly mode: 'literal' | 'regex' }
export interface MessageQuery {
  readonly at?: readonly MessageId[];
  readonly from?: readonly string[];
  readonly match?: MetadataMatch;
  readonly search?: MessageSearch;
  readonly cursor?: MessageCursor;
}
export interface ChannelHistoryQuery extends MessageQuery { readonly limit?: number | null; readonly order?: 'asc' | 'desc' }
export interface ChannelPendingOptions extends MessageQuery { readonly limit?: number }
export interface ChannelHistoryResult { readonly messages: readonly ChannelMessage[] }
export interface ChannelReceiveResult extends ChannelPendingResult { readonly consumed: number; readonly remaining: number }
export interface AckResult { readonly consumed: number }
export interface ChannelEndpointHold { readonly name: string; readonly generation: string; readonly attachment: 'attached' | 'detached' }
