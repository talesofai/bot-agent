# Character System (`/character`)

`/character` lets you create/edit/publish/use character cards.

## `/character help`

Shows character command usage.

## `/character create [name] [visibility] [description]`

Creates a character draft and opens an editing thread (multi-turn completion).

- `visibility`: `public|private` (default `private`)

## `/character open character_id:<id>` (creator only)

Opens the editing thread for a character.

## `/character view character_id:<id>`

Views a character card.

## `/character use character_id:<id>`

Sets your default character (global).

## `/character act character_id:<id>`

Sets your active character in the current world (world-scoped state).

## `/character publish [character_id]` / `/character unpublish [character_id]`

Publishes/unpublishes a character:

- only `public` characters are discoverable via `list/search`
- `character_id` can be omitted in the editing thread

## `/character list [limit]`

Lists your characters.

## `/character search query:<keyword> [limit]`

Searches public characters.

## `/character adopt character_id:<id> mode:<copy|fork>`

Adopts a public character by copying or forking it into your own list (default private).

## `/character export [character_id]` (creator only)

Exports a character card.

## `/character import file:<attachment> [character_id]` (creator only)

Imports (overwrites) a character card (`.md/.markdown/.txt` only).
