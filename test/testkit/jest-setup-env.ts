import { appEnvFromContainer } from './database';

// Runs before the test file is even loaded, and that is the whole point:
// app.module.ts calls ConfigModule.forRoot() while it is being imported, so the
// environment has to name the testcontainer before any `import` of the app graph.
// Setting it inside beforeAll() is too late — the configuration would already
// have been read from .env, and the suite would quietly test the compose
// database instead of the container it just started.
appEnvFromContainer();
