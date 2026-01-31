# Chat Shortcuts (Message Commands)

These are message-level shortcuts you can send as plain text messages (no need to use Slash Commands).

## `#<key> <text>` (session slot)

Selects a session slot (parallel contexts).

Examples:

```text
#0 continue this topic
#2 start a side thread
```

> The max slot is controlled by the group config `maxSessions`. Out-of-range keys are dropped.

## `.rd NdM` (dice roll)

Format: `.rd NdM`, e.g. `.rd 2d100`.

- `1 <= N <= 10`
- `1 <= M <= 100`

Examples:

```text
.rd 1d20
.rd 2d100
```

## `/nano <prompt>` / `/nano portrait [extra]`

Text-to-image shortcuts.

Examples:

```text
/nano a shiba inu wearing sunglasses, cyberpunk style
/nano portrait silver-haired knight, cool tones
```

## `/polish <draft>`

Polishes/re-writes the following draft without adding new facts/canon.

Example:

```text
/polish I'm tired today, but I still need to keep going.
```

## `/quest`

Generates 3–5 small actionable tasks (often with concrete steps/commands).

Example:

```text
/quest
```
