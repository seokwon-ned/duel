# Mockup A — Neon Arcade

Amy's final in-match visual. Portrait, 390-wide. Palette, HUD, board, pad, and juice are locked here.

## Palette

| Token | Hex |
|---|---|
| background | `#0F172A` |
| cover | `#6D28D9` / `#4C1D95` checker |
| me | `#FF7A1A` |
| opponent | `#2F6BFF` |
| accent | `#FACC15` |
| Sparx | `#F0ABFC` |
| text | `#F8FAFC` |

## Top HUD card

- Left: orange **ring** avatar, name `나`, 3 hearts
- Center: yellow-outlined timer (`2:49` in the mockup)
- Right: blue ring avatar, opponent name, 3 hearts
- Below: orange % bar from the left, blue % bar from the right, center marker `목표 50%`
- No ⚙ on this card (settings stay in the lobby / pause). Hearts must stay unobstructed.

## Board (middle, rounded card)

Neon purple glow border. Cover is the purple checker. Revealed cells show the bright dusk landscape.

- **꾸물이:** pink-red one-eyed jelly octopus, 4 dotted tentacles, angry brows
- **Sparx:** spiky pink stars `#F0ABFC` on the **outer border only** (one bottom, one right)
- **My line:** glowing orange `#FF7A1A` with an orb head
- **Opponent line:** dotted blue `#2F6BFF` with an orb head
- Glow is a blur layer (Phaser 4 `filters.internal.addGlow` / canvas `shadowBlur`)

## Bottom control pad

Separate card. Faint dot grid, curved orange arrow, center knob, copy `여기를 드래그해서 선을 그려요`. Input comes **only** from this pad.

## Safe area

Respect `env(safe-area-inset-top)` / `env(safe-area-inset-bottom)` (notch, home indicator). No 8px bottom overflow: playing layout is border-boxed so HUD + board + pad fit in 100dvh.

## Effects

| Beat | Treatment |
|---|---|
| Cut | Revealed area sweeps open, particles, yellow `+N%` popup, `싹둑!`, short screen shake |
| Hit | Red flash at the screen edge, a heart breaks, the line shatters and scatters |
| Win | Cover melts to the full picture, confetti |
