# Mockup A — Neon Cover Duel

Amy A visual spec for the Qix / Gals Panic versus board. Palette, HUD, board, actors, and juice are locked to this file. Engine rules do not change.

## Phaser

The in-match board is a Phaser scene (WebGL, Phaser 4 when available).

- **Filters:** `filters.internal.addGlow` on avatars/orbs, 꾸물이, Sparx, and the board outline. Phaser 3 fallback is `preFX.addGlow`. Canvas-only fallback bakes `shadowBlur` into the sprite textures.
- **Particles:** cut burst (~70), trail shatter on hit, confetti on win. Emitter textures are tiny tinted quads; explode at the claim centroid / trail / top of the board.
- **Shake:** short `cameras.main.shake` on cut. The cover board itself stays a 200×300 `CanvasTexture` (1 cell = 1 pixel) because the grid is ImageData; glow/particles sit in display-list layers above it.

## Palette

| Token | Hex | Use |
|---|---|---|
| background | `#0F172A` | App chrome; page fill is a vertical gradient `#111C3A` → `#0A0F20` |
| cover | `#6D28D9` → `#4C1D95` | Closed cover, vertical gradient |
| me | `#FF7A1A` | Player 1 line, orb, bar fill (left) |
| opponent | `#2F6BFF` | Player 2 line, tip, bar fill (right) |
| accent | `#FACC15` | Timer digits, 50% marker, cut popup |
| spark | `#F0ABFC` | Sparx body, cover specks |
| text | `#F8FAFC` | Primary type |
| hearts | `#FF4D6D` | Filled hearts; empty `#334155` |
| panel | `#1E293B` | HUD panel and drag pad |
| line core | `#FFE0C2` | Thin core inside the orange trail |
| 꾸물이 body | `#DB2777` | Boss body; tentacles `#BE185D`; suckers `#FBCFE8` |

Cover overlay: faint **36px checker** plus scattered faint `?` marks on the purple gradient.

## Type

Load from Google Fonts:

- **Black Han Sans** — headings, `싹둑!`, lobby title
- **Bungee** — timer, `%` digits, `+6%` popup
- **Jua** — body copy, names, drag hint, `목표 50%`

## HUD (~top 10%)

Rounded **40px** panel, fill `#1E293B`.

- Glowing circular avatars on both sides, name + **3 hearts** under/beside each.
- **Timer** in the center: rounded box, yellow outline, large yellow Bungee digits (`m:ss`).
- Bidirectional **% bar** under the timer:
  - me fills from the left in orange, with glow
  - opponent fills from the right in blue, with glow
  - white highlight strip across the top of the bar
  - `%` numbers sit inside the fills
- Yellow **50%** center line, triangle marker, label `목표 50%`.

No server URL, tick, or room id on this surface. ⚙ stays a quiet debug toggle.

## Board (~65%)

Rounded **36px**, drop shadow, purple neon outline glow.

- Closed cells: cover gradient + checker + `?`.
- Revealed cells: hidden illustration with a **slight** orange (P1) or blue (P2) team tint, plus a glowing border along the revealed/cover edge.
- Hidden illustration placeholder (dusk landscape): vertical sky `#1E3A8A` → `#FDBA74`, stars, sun glow, three purple mountain layers, lake reflection, trees, cottage, clouds.

### Trails and cutters

- **Me:** thick orange glow stroke + thin `#FFE0C2` core, smoothed through cell midpoints. Player is a glowing orb (white center) with a trailing afterimage.
- **Opponent:** blue glowing **dashed** line. Tip is a blue circle with a white outline.

### 꾸물이 (boss)

Pink jelly octopus. Four tentacles, sine sway, `#FBCFE8` suckers, one large eye, angry brows, pink outer glow. Recolors redder when angry (a player is drawing nearby, or opened share is high). Hidden until the match starts.

### Sparx

Eight-point spiky stars, `#F0ABFC` with a white center and glow. They circle the **outer rim only** (engine rule). Two of them.

## Juice

| Beat | Treatment |
|---|---|
| **Cut** | Revealed region sweeps open. ~70 orange / yellow / white particles. Big `+6%` yellow glow popup with a dark outline. `싹둑!` shout. Short screen shake. |
| **Hit** | Red flash at the screen edges. The lost heart breaks. The live line shatters and scatters. |
| **Win** | Remaining cover melts away to the full dusk image. Confetti. |

## Drag pad (~bottom 25%)

Rounded panel `#1E293B`, faint dot-grid. Orange glowing arc guide + looping finger animation. Copy: `여기를 드래그해서 선을 그려요` in `#94A3B8` (Jua). Relative-drag still starts from the first touch; the arc is a hint, not a joystick.

## Screens

Lobby, in-match (capture a cut), and results are the 390×844 QA surfaces. Same palette and type on all three.
