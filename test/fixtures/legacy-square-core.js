// Frozen test-only copy of the v1 fold/landed-audience replay semantics from
// square-core.ts at baseline 99679eb. This is the differential oracle the
// row-backed landing transition is compared against: do NOT "fix" behavior
// here, do not import it from production, and do not re-derive the row
// implementation from it. It is deliberately a plain JS copy so the oracle
// survives square-core.ts being replaced by the row-backed runtime.
//
// `landingGroups` is the frozen `recipientsAtLanding` algorithm kept as
// (recipient, route) pairs; the dedupe order is the documented priority
// bell > mention > reply > attention, so a recipient's first group is its
// route. `replayLandedAudiences` is that same loop with the recipient list
// projected out.

export const MAX_IDENTITY_SET_SIZE = 10;

export function nameKey(name) {
  return name.toLocaleLowerCase();
}

export function sameName(a, b) {
  return nameKey(a) === nameKey(b);
}

function uniqueMentionNames(names) {
  const unique = [];
  for (const name of names) {
    if (unique.some((existing) => sameName(existing, name))) continue;
    unique.push(name);
  }
  return unique;
}

export function audienceOf(say) {
  if (say.reach === 'bell') return { kind: 'bell' };
  return { kind: 'mentions', names: uniqueMentionNames(say.mentions ?? []) };
}

export function resolveAudience(audience, candidateNames) {
  if (audience.kind === 'bell') return [...candidateNames];
  const resolved = [];
  for (const mention of audience.names) {
    const known = candidateNames.find((candidate) => sameName(candidate, mention));
    if (known !== undefined && !resolved.some((existing) => sameName(existing, known))) {
      resolved.push(known);
    }
  }
  return resolved;
}

export function activeListeners(state, sender) {
  return state.participants
    .filter((participant) => participant.joined
      && !(state.ignored.get(nameKey(participant.name)) ?? []).some((target) => sameName(target, sender))
      && (state.listening.get(nameKey(participant.name)) ?? []).some((target) => sameName(target, sender)))
    .map((participant) => participant.name);
}

export function isIgnored(state, listener, sender) {
  return (state.ignored.get(nameKey(listener)) ?? []).some((target) => sameName(target, sender));
}

export function activityAuthors(acts) {
  const authors = new Map();
  for (const act of acts) {
    const actor = actorOf(act);
    if (actor === undefined || typeof act.index !== 'number') continue;
    authors.set(act.index, actor);
  }
  return authors;
}

export function actorOf(act) {
  if ('actor' in act && typeof act.actor === 'string') return act.actor;
  return undefined;
}

/** Verbatim v1 `recipientsAtLanding`: the merged recipient list, in landing order. */
export function recipientsAtLanding(before, say, authors) {
  const audience = audienceOf(say);
  const standing = before.participants.filter((participant) => participant.joined).map((participant) => participant.name);
  const mentionTargets = resolveAudience(audience, standing);
  const replyAuthor = say.reply === undefined ? undefined : authors.get(say.reply);
  const replyTargets = replyAuthor === undefined ? [] : resolveAudience({ kind: 'mentions', names: [replyAuthor] }, standing);
  const listeners = activeListeners(before, say.actor);
  const recipients = [];
  for (const name of [...mentionTargets, ...replyTargets, ...listeners]) {
    if (sameName(name, say.actor) || recipients.some((existing) => sameName(existing, name))) continue;
    if (audience.kind !== 'bell' && isIgnored(before, name, say.actor)) continue;
    recipients.push(name);
  }
  return recipients;
}

/**
 * The same frozen algorithm partitioned by the group that first reached each
 * recipient, so a recipient's route is the documented priority
 * bell > mention > reply > attention. This is a mechanical rearrangement of
 * `recipientsAtLanding`; the differential test asserts the recipient lists
 * stay identical, and the oracle was verified against the shipped v1
 * square-core over 400 random replays before the folds were removed.
 */
export function landingGroups(before, say, authors) {
  const audience = audienceOf(say);
  const standing = before.participants.filter((participant) => participant.joined).map((participant) => participant.name);
  const mentionTargets = resolveAudience(audience, standing);
  // A reply is directed attention in its own right: it reaches the author of the
  // replied-to activity under the same standing and ignore rules as a mention.
  const replyAuthor = say.reply === undefined ? undefined : authors.get(say.reply);
  const replyTargets = replyAuthor === undefined ? [] : resolveAudience({ kind: 'mentions', names: [replyAuthor] }, standing);
  const listeners = activeListeners(before, say.actor);
  const groups = [];
  const add = (name, route) => {
    if (sameName(name, say.actor) || groups.some((existing) => sameName(existing.recipient, name))) return;
    if (audience.kind !== 'bell' && isIgnored(before, name, say.actor)) return;
    groups.push({ recipient: name, route });
  };
  if (audience.kind === 'bell') {
    for (const name of standing) add(name, 'bell');
    return groups;
  }
  for (const name of mentionTargets) add(name, 'mention');
  for (const name of replyTargets) add(name, 'reply');
  for (const name of listeners) add(name, 'attention');
  return groups;
}

function touchParticipant(byKey, ordered, actor) {
  const key = nameKey(actor);
  const existing = byKey.get(key);
  if (existing !== undefined) return existing;
  const created = { name: actor, key, joined: false, done: false, activityCount: 0, lastReadThrough: -1 };
  byKey.set(key, created);
  ordered.push(created);
  return created;
}

function createAccumulator() {
  const ordered = [];
  const byKey = new Map();
  return {
    byKey,
    ordered,
    state: {
      participants: ordered,
      hold: { active: false },
      joined: [],
      done: [],
      throttleActivityAts: [],
      bellSayAtsByActor: new Map(),
      listening: new Map(),
      ignored: new Map(),
    },
  };
}

function applyActivity(accumulator, act) {
  const { state, byKey, ordered } = accumulator;
  const actor = actorOf(act);
  const snapshot = actor === undefined ? undefined : touchParticipant(byKey, ordered, actor);
  if (snapshot !== undefined && act.at !== undefined) {
    snapshot.lastActiveAt = Math.max(snapshot.lastActiveAt ?? -Infinity, act.at);
  }
  switch (act.kind) {
    case 'join':
      if (snapshot !== undefined) {
        snapshot.joined = true;
        snapshot.done = false;
      }
      break;
    case 'done':
      if (snapshot !== undefined) {
        snapshot.joined = false;
        snapshot.done = true;
        state.listening.delete(nameKey(snapshot.name));
      }
      break;
    case 'listen': {
      const key = nameKey(act.actor);
      const targets = state.listening.get(key) ?? [];
      if (!targets.some((target) => sameName(target, act.target))) targets.push(act.target);
      state.listening.set(key, targets);
      const ignored = (state.ignored.get(key) ?? []).filter((target) => !sameName(target, act.target));
      if (ignored.length === 0) state.ignored.delete(key); else state.ignored.set(key, ignored);
      break;
    }
    case 'ignore': {
      const key = nameKey(act.actor);
      const targets = (state.listening.get(key) ?? []).filter((target) => !sameName(target, act.target));
      if (targets.length === 0) state.listening.delete(key); else state.listening.set(key, targets);
      const ignored = state.ignored.get(key) ?? [];
      if (!ignored.some((target) => sameName(target, act.target))) ignored.push(act.target);
      state.ignored.set(key, ignored);
      break;
    }
    case 'say':
      if (snapshot !== undefined) snapshot.activityCount += 1;
      if (typeof act.at === 'number' && Number.isFinite(act.at)) state.throttleActivityAts.push(act.at);
      if (act.reach === 'bell' && typeof act.at === 'number' && Number.isFinite(act.at)) {
        const key = nameKey(act.actor);
        const current = state.bellSayAtsByActor.get(key) ?? [];
        current.push(act.at);
        state.bellSayAtsByActor.set(key, current);
      }
      break;
    case 'hold':
      state.hold.active = true;
      state.hold.at = act.at;
      state.hold.reason = act.body;
      state.hold.actor = act.actor;
      break;
    case 'resume':
      state.hold.active = false;
      delete state.hold.at;
      delete state.hold.reason;
      delete state.hold.actor;
      break;
    case 'read':
      if (snapshot !== undefined) {
        snapshot.lastReadThrough = Math.max(snapshot.lastReadThrough, act.through);
      }
      break;
  }
}

function finishFold(accumulator) {
  const { state, ordered } = accumulator;
  state.joined = ordered.filter((item) => item.joined).map((item) => item.name);
  state.done = ordered.filter((item) => item.done).map((item) => item.name);
  return state;
}

/** Frozen v1 `fold`: participant lifecycle, listening/ignored relations, hold. */
export function fold(acts) {
  const accumulator = createAccumulator();
  for (const act of acts) applyActivity(accumulator, act);
  return finishFold(accumulator);
}

/**
 * Frozen v1 replay: per-say landed recipients in landing order, participant
 * roster order, lifetime say counts, and last join index. `audience(index)`
 * and `lastJoinIndex(name)` are what the row-backed indices must reproduce.
 */
export function replayLandedAudiences(acts) {
  const accumulator = createAccumulator();
  const byIndex = new Map();
  const groupsByIndex = new Map();
  const lastJoinByKey = new Map();
  const authors = activityAuthors(acts);
  for (const act of acts) {
    if (act.kind === 'say') {
      byIndex.set(act.index, recipientsAtLanding(accumulator.state, act, authors));
      groupsByIndex.set(act.index, landingGroups(accumulator.state, act, authors));
    }
    if (act.kind === 'join') lastJoinByKey.set(nameKey(act.actor), act.index);
    applyActivity(accumulator, act);
  }
  const state = finishFold(accumulator);
  const participants = state.participants.map((participant) => participant.name);
  return {
    participants,
    joined: state.joined,
    done: state.done,
    listening: state.listening,
    ignored: state.ignored,
    hold: state.hold,
    sayCount: (name) => state.participants.find((participant) => sameName(participant.name, name))?.activityCount ?? 0,
    lastActiveAt: (name) => state.participants.find((participant) => sameName(participant.name, name))?.lastActiveAt,
    lastJoinIndex: (name) => lastJoinByKey.get(nameKey(name)),
    groups: (index) => groupsByIndex.get(index) ?? [],
    recipientsAtLanding: (index) => byIndex.get(index) ?? [],
    recipients: (index) => (byIndex.get(index) ?? []).map((item) => item.recipient),
    includes: (index, participant) => (byIndex.get(index) ?? []).some((item) => sameName(item.recipient, participant)),
  };
}
