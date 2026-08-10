import { Router } from 'express';
import { getTodos, createTodo, updateTodo } from '../controllers/todos.controller';

export const todosRouter = Router();

todosRouter.get('/', getTodos);
todosRouter.post('/', createTodo);
todosRouter.put('/:id', updateTodo);
