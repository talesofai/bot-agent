# Basics (Slash Commands)

This page covers the most common commands: `/help`, `/ping`, `/onboard`, `/language`.

## `/help`

Shows available commands and short tips.

## `/ping`

Health check. Useful to confirm the bot is online.

## `/onboard role:admin|both|adventurer|world creater`

Onboarding. It creates/opens your private onboarding thread in the server. Inside that thread, you can talk to the bot without mentioning it every time.

If your server enables Discord Server Onboarding (identity roles) and configures role mapping, the bot will auto-start the onboarding guide right after you pick an identity role and roles are assigned. `/onboard` still works to recover the entry link or switch roles.

- `role=admin`: admin guide (configure/maintain the bot)
- `role=adventurer`: adventurer onboarding flow (create character, join worlds)
- `role=world creater`: world creater onboarding flow (create/publish worlds)
- `role=both`: start both `adventurer` + `world creater` guides

Example:

```text
/onboard role:adventurer
```

## `/language lang:zh|en`

Sets your preferred reply language and affects the writing language of world/character docs.

Examples:

```text
/language lang:zh
/language lang:en
```
