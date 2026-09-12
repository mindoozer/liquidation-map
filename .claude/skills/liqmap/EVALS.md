# liqmap — trigger evals

Routing test set for the `liqmap` router (Garry Tan "Resolvers" → trigger evals). **How to use:**
after editing the mode table in `SKILL.md`, read each input below and confirm the router lands on
`expected`. A miss is fixed by editing the **SKILL.md mode table / aliases**, never by "trying harder"
— the description is the resolver. Phrasings deliberately include natural language that does *not*
contain the literal keyword (the false-negative risk the audit flagged).

cwd assumed: `liquidation-map/`.

| input (what the user types) | expected | note |
|---|---|---|
| *(empty)* | `read` | default |
| `show me the BTC liquidation map` | `read` | token + "map" → interpret current state |
| `am I about to get squeezed on HYPE?` | `squeeze` | NL, no keyword — must still route |
| `what's the squeeze score right now` | `squeeze` | literal |
| `where are the big walls` | `walls` | literal |
| `where does price get pulled / pinned toward?` | `magnets` | NL → the magnet thesis, not `walls` |
| `do the walls actually attract price?` | `magnets` | the lift question = magnets, not walls |
| `is this model any good? does it predict real liqs?` | `validate` | NL → ground-truth check |
| `how many real liquidations on ZEC today` | `validate` | (or `query`) — real-liq store |
| `re-fit the tier weights` | `calibrate` | NL for calibration |
| `what leverage are people actually using` | `leverage-fit` | NL → de-biased mix |
| `refresh the map` | `refresh` | literal |
| `publish to the site` | `publish` | literal — outward-facing, confirm first |
| `is the collector alive? is the data stale?` | `health` | `status` is an alias of `health` here |
| `did we miss any ticks yesterday? holes in the snapshots?` | `health` | continuity = `health` (gap check), not `query` |
| `FROM snaps WHERE tok='BTC' ORDER BY t DESC LIMIT 1` | `query` | raw SQL routes to query |
| `mute alerts for 2h` | `mute` | literal |

**Precedence / disambiguation**
- **Mode keyword wins over a bare token.** `squeeze BTC` → `squeeze` (not `read`); `validate ZEC` → `validate`.
- `status` is an **alias for `health`** here (fleet/pipeline liveness), *not* a P&L glance — don't confuse
  with the `pnl`/`agent` skills' `status`.
- `magnets` vs `walls`: a *list of levels* → `walls`; *"does price get drawn to them"* → `magnets`.

**Cross-skill false-positive guards** (should NOT trigger liqmap)
- `what's my P&L` / `did I make money` → **trades/`pnl`**, a different project (real fills, not the model).
- `how's the bot doing` / `can I go live` → **hl-agent/`agent`**.
