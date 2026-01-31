# World System (`/world`)

`/world` is the entry point of the world system: create/publish worlds, manage proposals/canon, and join worlds.

## `/world help`

Shows world command usage.

## `/world create` (create draft world)

Creates a draft world and opens your private editing thread. Complete the world card/rules through multi-turn chat, then publish with `/world publish`.

## `/world open world_id:<id>` (creator only)

Opens the editing thread for a specific world.

## `/world publish` (creator only; run inside the editing thread)

Publishes the current draft world and creates the world space (channels/role, etc.).

## `/world list [limit]`

Lists worlds (global).

## `/world search query:<keyword> [limit]`

Searches worlds by name/world-card/rules.

## `/world info [world_id]`

Shows the world card (`world_id` can be omitted inside that world’s channels).

## `/world rules [world_id]`

Shows the world rules (`world_id` can be omitted inside that world’s channels).

## `/world canon query:<keyword> [world_id]`

Searches canon (world-card/rules) for a keyword.

## `/world submit kind:<canon|chronicle|task|news> title:<title> content:<content> [world_id]`

Submits a proposal/task/canon addition (written to `world-proposals`, pending creator approval).

## `/world approve submission_id:<id> [world_id]` (creator only)

Approves a submission and writes it into canon/tasks/chronicle.

## `/world check query:<keyword> [world_id]`

Checks/searches whether canon/proposals contain a keyword.

## `/world join [world_id] [character_id]`

Joins a world (grants speaking permissions). Optionally specify `character_id`; otherwise uses your current character.

## `/world stats [world_id]` / `/world status [world_id]`

Shows world stats/status (`status` is equivalent to `stats`).

## `/world export [world_id]` (creator only)

Exports world docs (world-card / rules / canon).

## `/world import kind:<world_card|rules|canon> file:<attachment> [world_id]` (creator only)

Imports (overwrites) world docs:

- `kind=world_card`: overwrites `world-card.md`
- `kind=rules`: overwrites `rules.md`
- `kind=canon`: overwrites `canon/<filename>` (filename from the attachment name; `.md/.markdown/.txt` only)

## `/world remove world_id:<id>` (admin)

Removes a world (dangerous).
