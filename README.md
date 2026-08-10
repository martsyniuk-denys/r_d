# Todo API

Express + TypeScript + PostgreSQL backend for a Todo app.

## Setup

```
npm install
cp .env.example .env   # set DATABASE_URL to your Postgres instance
npm run migrate        # creates the todos table (or: psql "$DATABASE_URL" -f db/schema.sql)
npm run dev            # http://localhost:3000
```

## Endpoints

| Method | Path         | Body                                   | Description             |
| ------ | ------------ | --------------------------------------- | ------------------------ |
| GET    | `/todos`     | —                                        | List all todos           |
| POST   | `/todos`     | `{ "title": string, "completed"?: bool }` | Create a todo            |
| PUT    | `/todos/:id` | `{ "title"?: string, "completed"?: bool }` | Update an existing todo  |
