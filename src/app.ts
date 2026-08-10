import express from 'express';
import cors from 'cors';
import { todosRouter } from './routes/todos.routes';

export const app = express();

app.use(cors());
app.use(express.json());

app.use('/todos', todosRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});
