import type { SquareArtifactPort } from './ports.js';
import type { OpenSquare } from './open-square.js';
import {
  done as applyDone,
  express as applyExpress,
  hold as applyHold,
  ignore as applyIgnore,
  implicitJoin as applyImplicitJoin,
  join as applyJoin,
  listen as applyListen,
  listening as applyListening,
  resume as applyResume,
  type ListenerChangeResult,
} from './application.js';
import type { Activity, ExpressOptions, ExpressResult } from './square-facade.js';

/** Transitional adapter for existing internal callers until they migrate to SquareArtifactPort. */
type LegacySquare = { readonly cell: SquareArtifactPort; readonly clock: () => number };

function artifactOf(square: OpenSquare | LegacySquare): SquareArtifactPort {
  if ('artifact' in square) return square.artifact;
  const { cell } = square;
  return {
    read: () => cell.read(),
    transact: (fn) => cell.transact(fn),
    changed: (sinceVersion, timeoutMs) => cell.changed(sinceVersion, timeoutMs),
    close: () => cell.close(),
  };
}

function contextOf(square: OpenSquare | LegacySquare) {
  return { artifact: artifactOf(square), clock: square.clock, ...('location' in square ? { location: square.location, hostLedger: square.hostLedger, notifier: square.notifier } : {}) };
}

export function join(square: OpenSquare | LegacySquare, name: string): Promise<{ readonly name: string; readonly activity: Activity | null }> {
  return applyJoin(contextOf(square), name);
}

export function implicitJoin(square: OpenSquare | LegacySquare, name: string) {
  return applyImplicitJoin(contextOf(square), name);
}

export function express(square: OpenSquare | LegacySquare, name: string, body: string, options?: ExpressOptions): Promise<ExpressResult> {
  return applyExpress(contextOf(square), name, body, options);
}

export function listen(square: OpenSquare | LegacySquare, actor: string, target: string): Promise<ListenerChangeResult> {
  return applyListen(contextOf(square), actor, target);
}

export function ignore(square: OpenSquare | LegacySquare, actor: string, target: string): Promise<ListenerChangeResult> {
  return applyIgnore(contextOf(square), actor, target);
}

export function listening(square: OpenSquare | LegacySquare, actor: string): Promise<readonly string[]> {
  return applyListening(contextOf(square), actor);
}

export function done(square: OpenSquare | LegacySquare, name: string, body = ''): Promise<ExpressResult> {
  return applyDone(contextOf(square), name, body);
}

export function hold(square: OpenSquare | LegacySquare, name: string, reason = ''): Promise<ExpressResult> {
  return applyHold(contextOf(square), name, reason);
}

export function resume(square: OpenSquare | LegacySquare, name: string): Promise<ExpressResult> {
  return applyResume(contextOf(square), name);
}
