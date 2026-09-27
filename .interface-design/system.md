# Homebase design system

A household ledger for two. Paper, ink, coin. Read this before touching
`css/style.css`, `index.html`, or a renderer in `js/`.

## Direction

- **Who:** two partners on phones, in the kitchen at night or over coffee in
  the morning, tapping "Did it" and watching the shared wallet move.
- **Feel:** a ledger on the counter, not a SaaS dashboard. Quiet, warm,
  tabular. Nothing casts a shadow; rules do the structure.
- **Signature:** the ledger strip at the top of every screen (both wallets,
  today's movement), mono figures everywhere, ruled sections instead of
  cards, stake sentences under each entry ("$3.25 if you did it · a miss
  uses a freeze"), the dashed "still open" box for a catchable period.

## Tokens (`:root` in `css/style.css`)

| token | role |
| --- | --- |
| `--paper`, `--paper-raised`, `--paper-inset` | page, sheets and popovers, inputs. Whisper-quiet steps, same hue. |
| `--ink`, `--ink-2`, `--ink-3`, `--ink-4` | primary text, supporting, metadata, placeholder/disabled |
| `--rule`, `--rule-soft`, `--rule-strong` | section rules, row rules, focus and popover edges |
| `--coin`, `--coin-ink`, `--coin-wash`, `--coin-ring` | money figures and the one action color |
| `--bill`, `--bill-wash` | money in, done states |
| `--brick`, `--brick-wash` | money out, misses, errors |

Dark is the default (warm charcoal); light is ledger cream under
`prefers-color-scheme: light`. Never add a hue for a surface.

## Depth

Borders only. Sheets (`.card`) are `--paper-raised` with a 1px `--rule`.
Popovers (`.more-sheet`, `.cat-panel`) are the same surface with
`--rule-strong`. Inputs are inset (`--paper-inset`). No box-shadow anywhere.

## Type

- Text: Source Sans 3 (Google Fonts), system fallback. 16px body.
- Figures: IBM Plex Mono, tabular. Apply through `.num` or the shared
  selector list at the top of the stylesheet; every dollar amount, count,
  and date-in-a-grid is mono.
- Section labels: 0.72rem, 600, uppercase, 0.12em tracking, `--ink-3`.

## Spacing and corners

4px base. Entries pad 14/16 vertically; content under an entry head indents
40px (glyph width 28 + gap 12). Corners: 6px small controls, 10px buttons
and inputs, 14px sheets.

## Patterns

- **Shell:** `#strip` (brand, me, partner, tally) then `#navMenu` tabs
  (Home, Inbox, Budget, Calendar, More). Tabs are fixed to the bottom on
  phones and inline under the strip from 700px.
- **Dashboard:** `.block` sections with `.block-title`, rows are `.entry`
  with `.entry-head` (glyph, name + sub-line, right-hand figure), then a
  `.stake` sentence, then `.actions`. No cards on the dashboard.
- **Actions:** `button.ok` is coin-filled, the one primary. `button.danger`
  and `button.ghost` are outlined; `button.ok-ghost` is outlined in coin for
  a secondary claim ("Together"). Amounts inside a button use `.amt`.
- **States:** `.status` (done) and `.status.bad` (missed) replace the action
  row; `.ask` is the inline confirmation; `.inline-err` sits under the row.
- **Feed:** `.fe-row` grid, grouped by the Denver day the line happened,
  the period it is about in the sub-line.
- **Other screens:** one `.card` sheet each. Keep it one surface.

## Avoid

Gradients, shadows, a second accent, emoji as decoration in labels, a
number shown twice in one entry.
