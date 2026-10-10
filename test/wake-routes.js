// Test scaffolding for wake routes.
//
// Square's production code publishes routes through `publishWakeRoute(artifact, ...)` and reads
// them straight off the square artifact; nothing in production needs a path-based reader, so
// these helpers open the square the same way `withArtifact` used to and assert on real state.
import fs from 'node:fs';

import { canonicalPath } from '../dist/canonical-path.js';
import { nameKey } from '../dist/model.js';
import { closeOpenSquare } from '../dist/open-square.js';
import { dropSessionWakeRoutesFromState, publishWakeRoute, retireWakeRouteFromArtifact, ROUTE_FRESH_MS } from '../dist/routes.js';
import { openSquare } from '../dist/square-file-adapter.js';

async function withArtifact(location, fn) {
  if (location === undefined) return undefined;
  try {
    await fs.promises.access(location);
    const square = await openSquare(location);
    try { return await fn(square); } finally { await closeOpenSquare(square); }
  } catch { return undefined; }
}

export async function readWakeRoutes(opts = {}) {
  const now = opts.now ?? Date.now();
  const canonicalLocation = opts.location === undefined ? undefined : await canonicalPath(opts.location);
  const routes = await withArtifact(canonicalLocation, async (square) => (await square.artifact.read()).state.routes ?? []) ?? [];
  const filtered = routes.filter((route) => (opts.participant === undefined || nameKey(route.participant) === nameKey(opts.participant)) && (opts.sessionId === undefined || route.sessionId === opts.sessionId) && (!opts.freshOnly || now - route.updatedAt < ROUTE_FRESH_MS));
  const canonicalized = await Promise.all(filtered.map(async (route) => ({ ...route, location: await canonicalPath(route.location), address: { ...route.address } })));
  return canonicalLocation === undefined ? canonicalized : canonicalized.filter((route) => route.location === canonicalLocation);
}

export async function upsertWakeRoute(route, opts = {}) {
  const location = await canonicalPath(route.location);
  await withArtifact(location, async (square) => publishWakeRoute(square.artifact, { ...route, location }, opts));
}

export async function retireWakeRoute(route, opts = {}) {
  const location = await canonicalPath(route.location);
  await withArtifact(location, async (square) => retireWakeRouteFromArtifact(square.artifact, { ...route, location }, opts));
}

export async function retireWakeRoutesForSession(artifact, route, opts = {}) {
  await artifact.transact((state) => { dropSessionWakeRoutesFromState(state, route.location, route.sessionId, opts.expectedEpoch); return { state, result: undefined }; });
}
