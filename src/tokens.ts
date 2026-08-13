export const CONFIG_TOKEN = Symbol.for('CONFIG');

export const LOGGER_TOKEN = Symbol.for('LOGGER');

export interface AppConfig {
  appName: string;
  port: number;
}

export interface Logger {
  log(message: string): void;
}
