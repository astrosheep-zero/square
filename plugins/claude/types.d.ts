export type SquareInboxBinding = { location: string; participant: string; session: string; epoch?: number };
export type SquareInboxCoordinate = { sessionId: string; cwd: string; version: string; endpoint?: string };
export type SquareInboxCancellation = { at: number; bindings?: SquareInboxBinding[] };
export type SquareInboxState = { coordinate: SquareInboxCoordinate; bindings?: SquareInboxBinding[] };
declare module 'claude-code' {
  interface PluginState { square: { inbox: StateFamily<SquareInboxState>; cancelAt: StateFamily<SquareInboxCancellation> } }
}
