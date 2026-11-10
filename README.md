# nestjs-workers

Starter: **NestJS 12 + Bun + TypeScript 7**.

## Requirements

- Bun >= 1.1.0 (`bun --version`)
- TypeScript 7 (`bunx tsc --version`)
- NestJS 12

## Quick start

```bash
bun install
bun run start:dev
```

App: http://localhost:3000

- `GET /` — Hello World
- `GET /health` — `{ "status": "ok" }`

## Scripts

| Script | Command |
|---|---|
| dev (hot reload) | `bun run start:dev` |
| start | `bun run start` |
| prod (from `dist/`) | `bun run start:prod` |
| build (`tsc`) | `bun run build` |
| typecheck | `bun run typecheck` |

## Build binary with Bun

```bash
bun build ./src/main.ts --compile --target bun --outfile=nestjs-workers
./nestjs-workers
```

## Structure

```
src/
  main.ts
  app.module.ts
  app.controller.ts
  app.service.ts
```
