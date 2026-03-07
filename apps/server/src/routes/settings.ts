import type { FastifyInstance } from 'fastify';
import { AuthService } from '../security/auth-service.js';
import { ConfigService } from '../config/service.js';

export async function registerSettingsRoutes(app: FastifyInstance, authService: AuthService, configService: ConfigService): Promise<void> {
  app.get('/api/settings', async (request, reply) => {
    try {
      await authService.ensureAuthenticated(request, reply, false);
    } catch {
      return;
    }
    const config = configService.getConfig();
    return {
      configPath: configService.getConfigPath(),
      projectsRoot: config.projectsRoot,
      serverHost: config.server.host,
      serverPort: config.server.port,
      security: {
        trustTailscaleHeaders: config.security.trustTailscaleHeaders,
        cookieSecure: config.security.cookieSecure,
        sessionTtlHours: config.security.sessionTtlHours,
      },
    };
  });
}
