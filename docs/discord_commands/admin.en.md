# Admin & Session Commands

This page covers session/admin commands: `/reset`, `/resetall`, `/model` (and their message equivalents).

## `/reset [key] [user]`

Creates a new session (i.e., starts a fresh conversation context).

- `key`: session slot (default `0`; must be a non-negative integer)
- `user`: target user (defaults to yourself; **admin only** when targeting others)

Examples:

```text
/reset
/reset key:2
/reset key:0 user:@someone
```

Message equivalents:

```text
/reset
#2 /reset
```

## `/resetall [key]` (admin only)

Resets all sessions in the guild/channel scope for a given slot.

Examples:

```text
/resetall
/resetall key:1
```

Message equivalents:

```text
/reset all
#1 /reset all
```

## `/model name:<modelId|default>` (admin only)

Switches the group model override:

- `default`: clears the override
- `<modelId>`: must be in the `OPENCODE_MODELS` allowlist (slashes `/` are allowed)

Examples:

```text
/model name:default
/model name:vol/glm-4.7
```

Message equivalents:

```text
/model default
/model vol/glm-4.7
```
