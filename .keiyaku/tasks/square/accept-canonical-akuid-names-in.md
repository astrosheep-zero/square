---
id: task/square/accept-canonical-akuid-names-in
title: Accept canonical AkuId names in Square listening
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T13:05:33.236Z
updatedAt: 2026-08-28T13:32:55.965Z
---
Extend Square's one canonical slash-segment name grammar so every canonical Keiyaku AkuId, including complete RGI emoji archetype graphemes, is a valid participant/listener target. Preserve all existing valid names and reject whitespace, controls, punctuation, and incomplete emoji sequences. Update the sole grammar law and tests; prepare the next package version but do not publish without explicit authority.