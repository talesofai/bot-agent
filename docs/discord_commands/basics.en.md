# Basics (Slash Commands)

This page covers the most common commands: `/help`, `/ping`, `/onboard`, `/language`.

## `/help`

Shows available commands and short tips.

## `/ping`

Health check. Useful to confirm the bot is online.

## `/onboard role:player|creator`

Onboarding. It creates/opens your private onboarding thread in the home guild. Inside that thread, you can talk to the bot without mentioning it every time.

If your server enables Discord Server Onboarding (identity roles) and configures role mapping, the bot will auto-start the onboarding guide right after you pick an identity role and roles are assigned. `/onboard` still works to recover the entry link or switch roles.

- `role=player`: player onboarding flow
- `role=creator`: creator onboarding flow

Example:

```text
/onboard role:player
```

## `/language lang:zh|en`

Sets your preferred reply language and affects the writing language of world/character docs.

Examples:

```text
/language lang:zh
/language lang:en
```
