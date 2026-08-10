import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import { Todo } from '../types';

export async function getTodos(_req: Request, res: Response, next: NextFunction) {
  try {
    const result = await pool.query<Todo>(
      'SELECT * FROM todos ORDER BY id ASC'
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
}

export async function createTodo(req: Request, res: Response, next: NextFunction) {
  try {
    const { title, completed } = req.body;

    if (typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'title is required and must be a non-empty string' });
    }
    if (completed !== undefined && typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'completed must be a boolean' });
    }

    const result = await pool.query<Todo>(
      'INSERT INTO todos (title, completed) VALUES ($1, $2) RETURNING *',
      [title.trim(), completed ?? false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    next(err);
  }
}

export async function updateTodo(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ error: 'id must be an integer' });
    }

    const { title, completed } = req.body;
    if (title === undefined && completed === undefined) {
      return res.status(400).json({ error: 'provide at least one of: title, completed' });
    }
    if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
      return res.status(400).json({ error: 'title must be a non-empty string' });
    }
    if (completed !== undefined && typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'completed must be a boolean' });
    }

    const result = await pool.query<Todo>(
      `UPDATE todos SET
         title = COALESCE($1, title),
         completed = COALESCE($2, completed),
         updated_at = now()
       WHERE id = $3
       RETURNING *`,
      [title?.trim() ?? null, completed ?? null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: `todo ${id} not found` });
    }
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
}
