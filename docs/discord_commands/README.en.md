# Discord Commands (Overview)

This folder documents **Discord commands** (Slash Commands + message shortcuts). It is also linked from the World Wiki “Commands” section.

## Quick Links

- Basics: [`basics.md`](./basics.md)
- Admin & Sessions: [`admin.md`](./admin.md)
- Chat Shortcuts: [`chat.md`](./chat.md)
- World System: [`world.md`](./world.md)
- Character System: [`character.md`](./character.md)

## Overview

### Slash Commands

- `/help`: Show available commands and tips
- `/ping`: Health check
- `/onboard role:player|creator`: Onboarding (creates/opens your private onboarding thread)
- `/language lang:zh|en`: Set reply language (also affects world/character doc writing language)
- `/reset [key] [user]`: Reset session (admins can target a user)
- `/resetall [key]`: Reset all sessions in the guild/channel scope (admin only)
- `/model name:<modelId|default>`: Switch model override (admin only; `default` clears override)
- `/world …`: World system (create/publish/canon/proposals/join, etc.)
- `/character …`: Character system (create/publish/use/import/export, etc.)

### Message Shortcuts (send as plain messages)

These are **content-level** shortcuts: you can send them as normal messages (no need to use Slash Commands).

- `#<key> <text>`: Select a session slot (e.g. `#2 continue`)
- `.rd NdM`: Dice roll (e.g. `.rd 2d100`; does NOT call AI)
- `/nano <prompt>`: Text-to-image (built-in skill)
- `/nano portrait [extra]`: Portrait preset (built-in skill)
- `/polish <draft>`: Rewrite/polish text (built-in skill)
- `/quest`: Generate 3–5 actionable next steps (built-in skill)
- `/reset` / `/reset all`: Reset sessions (message version of reset commands)
- `/model <name>` / `/model default`: Switch model (message version of `/model`)

See the sub-pages for details.
