/** SDK-free structural subset of Pi's custom message and native options. */
export interface PiMessage<T = unknown> {
  customType: string
  content: string | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  display: boolean
  details?: T
}
export interface PiSendOptions {
  deliverAs?: 'steer' | 'followUp' | 'nextTurn'
  triggerTurn?: boolean
}
export interface PiSender {
  sendMessage<T = unknown>(message: PiMessage<T>, options?: PiSendOptions): void
}

/** One stateless invocation. Void is not admission or observable async failure. */
export function sendPiMessage<T>(pi: PiSender, message: PiMessage<T>, options?: PiSendOptions): void {
  pi.sendMessage(message, options)
}
