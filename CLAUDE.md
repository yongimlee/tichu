# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A real-time, online **Tichu** (4-player, 2-team trick-taking card game). TypeScript monorepo with a server-authoritative Socket.IO backend and a React/Vite frontend. Game rules live in a platform-agnostic `shared` package so a future mobile client (Capacitor) can reuse them. User-facing text is Korean.

## Commands

Run from the repo root unless noted.

```bash
npm install            # install all workspaces
npm run dev            # server (:3001) + web (:5173) together (concurrently)
npm run dev:server     # server only (tsx watch)
npm run dev:web        # web only (vite)
npm run typecheck      # tsc --noEmit across shared, server, web (run before finishing work)

npm run build          # build the web client into web/dist
npm start              # run the server in production mode (serves web/dist if present)
```

Tests (only `shared` has them — `node:test`):

```bash
npm test -w @tichu/shared                                   # all shared tests
node --import tsx --test shared/src/game.test.ts            # one test FILE
node --import tsx --test --test-name-pattern="wish" shared/src/game.test.ts   # one test by name
```

## No build step for `shared`

`shared` is consumed straight from its TypeScript source, never compiled:
- `shared/package.json` `main`/`exports` point at `./src/index.ts`.
- The server runs TS directly via `tsx`.
- The web client aliases `@tichu/shared` → `../shared/src/index.ts` in `web/vite.config.ts`.

So editing `shared` is picked up everywhere with no rebuild. `tsconfig.base.json` is the shared compiler config.

## Architecture

### Workspaces
- **`shared/`** — pure domain, no DOM/server deps. `cards.ts` (deck, points, ranks), `combinations.ts` (족보 detection + `canBeat` comparison), `game.ts` (the hand state machine), `room.ts` (room/seat/team helpers), `events.ts` (typed Socket.IO event contracts), `emotes.ts`. Re-exported via `index.ts`.
- **`server/`** — Express + Socket.IO. Authoritative state owner.
- **`web/`** — React + Vite SPA.

### Server-authoritative state, split two ways
The server is the single source of truth. A client never receives the raw `GameState` (which contains every player's cards). Two managers are deliberately kept separate so private hand data never rides a lobby broadcast:
- **`RoomManager`** — lobby/room membership, seats, teams, hosts, reconnect tokens, room cleanup. Broadcast freely via `room:update`.
- **`GameManager`** — the in-progress match: cumulative team scores + the current hand's `GameState`. Each player is sent only their own redacted view via `toPlayerView(state, seat, match)` (in `shared/game.ts`), emitted per-socket.

`server/src/index.ts` wires them: `RoomManager`'s cleanup callback calls `games.end(code)`.

### The hand state machine (`shared/src/game.ts`)
Phases: `grand-tichu → exchange → playing → scoring → finished`. The exported transition functions (`declareGrandTichu`, `submitExchange`, `declareTichu`, `playCards`, `pass`, `giveDragon`) **mutate the passed-in `GameState` in place** — the server holds one object per room and applies events sequentially. Phase advances happen inside these functions when the last required player acts (e.g. `declareGrandTichu` deals the remainder once all four decide). Special-card rules (Mahjong wish enforcement, Dog lead, Phoenix wildcard, Dragon trick handoff) and bomb-out-of-turn interrupts all live here.

### Socket layer (`server/src/socket.ts`)
`registerSocketHandlers(io, socket, rooms, games, bots)` binds one connection. Game mutations go through the `withGame` helper, which: runs the transition → `games.settle(code)` (scores a finished hand exactly once) → emits each seat its redacted view → `bots.kick(code)`. Acks carry a reconnect `token`. Match scoring + the 1000-point (configurable) finish lives in `GameManager.settle`.

### Bots (`server/src/bot.ts`)
Server-controlled fill players so a solo human can play. `BotDriver` watches each room and, on a short timer, performs the pending bot action (`pendingBotAction` + `applyBotAction`). Strategy lives in `botMove`/`chooseLead`/`fulfillingMoves` etc. **Design decisions worth knowing:** bots never declare Tichu/Grand Tichu (simulation showed it is negative-EV for a non-coordinating solo bot); `fulfillingMoves` mirrors the engine's `canFulfillWish` enumeration exactly so a bot never picks a wish-violating move (a mismatch would stall the game via the driver's fallback). Validate bot changes with throwaway simulation scripts at the repo root (run with `npx tsx`, then delete) — there is no committed bot test suite.

### Reconnection & cleanup
Players get a reconnect token (server `tokens` map + client `localStorage` key `tichu.session`). An in-game disconnect keeps the seat and marks the player offline; the client auto-reconnects via `room:reconnect`. If it becomes an offline player's turn, the `BotDriver` covers it after a longer delay (`OFFLINE_TAKEOVER_MS`) so one drop doesn't stall the table — `pendingBotAction` treats a disconnected human's seat like a bot's; reconnecting takes control back. The driver pauses entirely while every human is offline. When all humans go offline a purge timer runs (default 60s grace, cancelled on reconnect). A solo room (one human + bots) uses a shorter grace (`min(graceMs, 10s)`).

### Client (`web/src/`)
`App.tsx` holds top-level room/session state and renders pages (`Home`, `RoomView`, `GameView`). `web/src/socket.ts` is the singleton Socket.IO client (`SERVER_URL` is `:3001` in dev, same-origin in a production build, overridable via `VITE_SERVER_URL`). `pages/Demo.tsx` renders every phase/scenario with hand-built `PlayerView` literals for visual iteration without a running server — keep its literals in sync when you change shared view types.

### Single-deploy mode
In production the server serves `web/dist` (Express static + SPA fallback) from the same origin, so the whole app is one service with no CORS. `render.yaml` is the Render blueprint (`npm run build` then `npm start`). State is in-memory → single instance only; a restart drops in-progress games.

## Conventions
- **New game rules** go into `shared` as pure functions with a `node:test` test, then are wired through `server/src/socket.ts` as events, and exposed to clients by extending `toPlayerView`. Verification loop: `npm run typecheck` + `npm test -w @tichu/shared`.
- **Display vs identifiers:** user-facing strings say `라지 티츄` (not 그랜드 티츄) and `참새` (not 마작), but the internal identifiers stay `grandTichu` / `'grand-tichu'` / `mahjong`. Don't rename the identifiers.
- This is a Windows environment; the Bash tool uses Git Bash (not PowerShell) — mind shell quoting differences, especially in commit messages.
