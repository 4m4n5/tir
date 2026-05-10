# tir — Game Design Questions (fill in answers inline)

Please answer directly under each question. Short bullets are perfect.

---

## 1) One-sentence pitch
- **Your one-liner**:
  - > (defer for now)

---

## 2) Core “distance” definition (most important)
We need a precise definition of “closest word”.

- **Distance type (pick one for v1)**:
  - Embedding/semantic similarity (vector distance)
  - Word ladder (edit/letter changes)
  - Thesaurus/ontology graph (edges like synonym/related)
  - Custom curated graph
  - Other:
  - > **Yes, semantic (meaning-based) similarity.** Words are connected by what they mean, not how they're spelled. "cat" leads to "dog"/"kitten"/"mouse" — never "car"/"cap". Powered by GloVe (word co-occurrence) embeddings with a lexical overlap filter to strip character-pattern noise. Vocab is ~900 curated common English words — lexically simple, semantically rich.

- **Allowed tokens**:
  - Single words only?
  - Are plurals/verb tenses allowed?
  - Proper nouns allowed?
  - Profanity allowed?
  - > Single words only: yes
  - > Plurals/verb tenses: no
  - > Proper nouns: probably
  - > Profanity: no

- **Language(s)**:
  - English only at launch?
  - Future languages:
  - > English at launch: yes
  - > Future: Hindi

- **Do players see a numeric distance / “hotness meter”?**
  - Yes/No
  - If yes, what (e.g., percentile, “warmer/colder”, exact score):
  - > NO (hide distance)

---

## 3) Round structure + pacing
- **How long should a round feel?**
  - Typical target: ___ seconds/minutes
  - > About ~15 seconds

- **Does the target change immediately when the first person hits it?**
  - Yes/No
  - If yes, do we add a short countdown (e.g., 3–5s) so it feels fair?
  - > Not really. When one person hits, start a 3s timer for other players to finish or pivot/position themselves for the next round.
  - > Yes, a short countdown sounds nice.

- **Alternative**: time-boxed rounds (e.g., 60–120s) then top N win.
  - Interested? Yes/No
  - If yes, what round length + top N:
  - > No

---

## 4) Player turn mechanics (the “pick 1 of 4” loop)
- **Is there a time limit per pick?**
  - Yes/No
  - If yes, how many seconds:
  - > No

- **How are the 4 options generated?**
  - Always the 4 nearest neighbors?
  - Mix of good + decoy options?
  - Options personalized per player, or shared for everyone?
  - Any “anti-solve” strategy you want (to avoid optimal paths being memorized)?
  - > Always the 4 nearest **semantic** (meaning-based) neighbors, with MMR diversity to avoid boxing the player into one semantic domain. Options reflect word meaning, never spelling similarity.
  - > No decoys.
  - > We can think about some kind of personalization in one of the options to add a long-term “subtext”.
  - > Yes: some anti-bot measure to keep it fair/fun.

- **Can a player ever get stuck or cycle between words?**
  - Yes/No
  - If yes, do we allow:
    - Reroll (cost?)
    - Backtrack (cost?)
    - Hint (cost?)
  - > No

- **Do we show the full target word at all times?**
  - Always visible / partially visible / hidden until close / other:
  - > Always visible

---

## 5) Multiplayer topology (“everyone online”)
- **Is “everyone online” truly global, or are there arenas/lobbies?**
  - Global single shard
  - Multiple arenas (matchmaking)
  - Friends/private rooms
  - > Global single shard: yes (default mode; works even solo)
  - > Multiple arenas: no matchmaking yet
  - > Friends/private rooms: yes

- **Note on modes**:
  - > No separate “Ranked Leagues” mode — ranking/leagues can exist, but not as a distinct mode.

- **If arenas**:
  - Ideal arena size (e.g., 20 / 50 / 100 / 200):
  - How to matchmake (region, skill, random):
  - > No arenas (for now)

- **Do we want spectators / live leaderboard / killfeed-style events?**
  - Yes/No
  - If yes, what:
  - > No

---

## 6) Spawning new players (your “average distance” idea)
When a player joins mid-round, you want to assign their current word based on the average distance of other players from the target.

- **Goal of spawning** (pick the primary):
  - Competitive immediately (spawn near average)
  - Chase experience (spawn behind average)
  - Handicap by skill (good players spawn farther)
  - Other:
  - > Chase experience (spawn behind average)

- **What data do we use for “average”?**
  - Mean / median / trimmed mean?
  - Over last N seconds, or all current players?
  - > Median
  - > Over last ~5 seconds (or whatever is simpler)

- **How far from average should the joiner spawn?**
  - Exactly average / slightly behind / randomized band:
  - > Randomized band (behind average)

- **Should joiners ever be “protected” from instant target switch?**
  - Yes/No (e.g., can’t win for 10s after joining, or they spawn in next round)
  - > No

---

## 7) Win condition + excitement design
- **Primary win condition**:
  - First to reach target
  - Top N within time window
  - “King of the hill” (hold target for X seconds)
  - Other:
  - > First to reach target. Winner hits first; anyone hitting within next 3 seconds gets bonus + recognition.

- **If “first to reach target”**:
  - How do we prevent one very fast player from ending rounds too quickly?
    - Minimum round time?
    - Cooldown before target can switch?
    - Multiple winners threshold (e.g., first 3 to hit within 5s)?
    - Skill matchmaking / arenas?
  - > The 3s win window helps a little.

---

## 8) Rewards + progression (what feels addictive but fair)
- **What do rewards unlock?** (pick all that apply)
  - Cosmetics (themes, avatars, titles)
  - Rank/elo + leagues
  - Currency (soft)
  - Currency (hard)
  - Power-ups (rerolls/hints)
  - Battle pass progression
  - Other:
  - > Cosmetics: somewhat, but minimal and tasteful
  - > Rank/elo + leagues: yes
  - > Soft currency: no
  - > Hard currency: no
  - > Power-ups: rerolls are fun
  - > Battle pass: no

- **Pay-to-win tolerance**:
  - Strictly no pay-to-win
  - Mild (paid cosmetics only)
  - Okay with paid power-ups (risky)
  - > Strictly no pay-to-win

- **Streaks**:
  - Daily streak? Yes/No
  - Win streak multiplier? Yes/No
  - > Daily streak: yes
  - > Win streak multiplier: yes

---

## 9) Reward formula inputs (you mentioned several)
You mentioned: closeness to final word, number of players online, and more.

- **Inputs you definitely want included** (check all):
  - Placement (1st/2nd/3rd)
  - Final distance when round ends (for non-winners)
  - Speed (time to target / moves taken)
  - Difficulty of target (rarity)
  - Arena population size
  - Upset factor (beating higher-rated players)
  - Comeback factor (starting far but finishing high)
  - Streak multiplier
  - Other:
  - > Placement: yes
  - > Final distance for non-winners: yes
  - > Speed / moves: yes
  - > Difficulty/rarity: no
  - > Population size: yes
  - > Upset factor: yes
  - > Comeback factor: yes
  - > Streak multiplier: yes

- **Do non-winners get meaningful rewards?**
  - Yes/No
  - If yes, what should feel “worth it” for a 60s session?
  - > Not sure; let’s think about it more.

- **Do you want risk/reward choices?**
  - Example: “cash out now” vs “continue for multiplier”
  - Yes/No (describe):
  - > Not sure about the question yet.

---

## 10) Content strategy (targets + word graph)
- **Target selection**:
  - Common words only / mixed / rare “boss” targets
  - Any banned categories:
  - > This combination sounds good. Harder when more players are playing; conditioned on where other players are currently. If rounds end too quickly, targets should get harder. If only one person is playing, it should feel approachable/possible.

- **Theming**:
  - Random
  - Daily theme
  - Event themes (weekends, holidays)
  - > Random: yes

- **Do we need categories shown to player?**
  - Yes/No (e.g., “animal”, “food”)
  - > No

---

## 11) Social features
- **Chat**:
  - None / emojis only / full text / team chat
  - > Emoji only

- **Friends + parties**:
  - Yes/No
  - Private rooms? Yes/No
  - > Yes
  - > Private rooms: yes

- **Clans/guilds**:
  - Yes/No
  - > No

---

## 12) Anti-cheat + “solvability”
- **Are you okay with a meta where players can learn optimal paths over time?**
  - Yes/No
  - > No

- **Any anti-bot needs?**
  - None / basic / serious (describe):
  - > Basic

- **Do we need to hide information to keep it unsolved?**
  - Hide distance / hide target / rotate graphs / per-player options / other:
  - > Only hide distance

---

## 13) UX and vibe (how it should feel)
- **Pick 1–2 vibes**:
  - Fast twitch (rapid decisions)
  - Strategic (thinky)
  - Social chaos (spectating, reactions)
  - Minimal/zen but competitive
  - > Fast twitch: yes (dynamic/fast moving)
  - > Strategic: no (should not feel slow)
  - > Social chaos: a lil bit
  - > Minimal/zen but competitive: yes (minimal yet exciting/competitive)

- **Session length target**:
  - 30–60s
  - 2–5 min
  - 10+ min
  - > 2–5 min

---

## 14) Monetization (so we don’t design into a corner)
- **Monetization model (pick)**:
  - Ads
  - Cosmetics shop
  - Battle pass
  - Subscription
  - Coin packs
  - Other:
  - > (not decided yet)

---

## 15) Tech constraints / preferences (so we pick the right stack later)
- **Cross-platform preference**:
  - React Native
  - Flutter
  - Native (Swift + Kotlin)
  - No preference
  - > No preference (whatever works most smoothly with requirements)

- **Backend preference**:
  - Firebase / Supabase / custom server
  - No preference
  - > No preference

- **Realtime requirement** (how “live” must it be?):
  - Truly realtime (<300ms)
  - Near-realtime (1–2s is fine)
  - Doesn’t matter
  - > Truly realtime

---

## 16) Your “north star” metrics
- **What do you care about most?**
  - DAU
  - Avg session length
  - Sessions per day
  - Retention D1/D7/D30
  - Virality (invites)
  - Revenue per DAU
  - > DAU

- **One thing you absolutely do NOT want** (e.g., pay-to-win, toxicity, too slow, too random):
  - > Pay-to-win


---

## 17) Follow-up questions (to lock v1 rules)
- **Tagline / one-liner pitch** (App Store style, 1 sentence):
  - >

- **Rerolls** (you said rerolls are fun):
  - Should a reroll replace:
    - All 4 options, or
    - Just 1 slot (pick which slot), or
    - Just the worst option, or
    - Something else:
  - > Yeah all 4 is good

- **Finish window UX** (your 3-second win window):
  - When someone hits the target, do we show a global banner like “FINISH WINDOW: 3…2…1…”?
  - Yes/No
  - > Yes

- **“Player count” in rewards**:
  - Should reward scaling use:
    - Global online count, or
    - Count of players active in the current round/shard, or
    - Rolling average of active players (last N seconds), or
    - Other:
  - > Rolling average of active players

