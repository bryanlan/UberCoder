import { buildApp } from './app.js';

const { app, config } = await buildApp();
const address = await app.listen({
  host: config.server.host,
  port: config.server.port,
});
app.log.info(`Agent Console listening at ${address}`);
